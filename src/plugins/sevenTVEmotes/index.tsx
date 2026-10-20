/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { Alerts, React, TextInput, Tooltip } from "@webpack/common";

const logger = new Logger("SevenTVEmotes");

const API_HOST = "https://7tv.io";
const CDN_HOST = "https://cdn.7tv.app";

// Nombre de la vista del selector de expresiones (GIF / Stickers / Emoji / 7TV)
const PICKER_VIEW = "7tv";

// Flags de 7TV
const ACTIVE_EMOTE_ZERO_WIDTH = 1 << 0; // flag del emote dentro del set
const EMOTE_DATA_ZERO_WIDTH = 1 << 8; // flag del emote en sí

// Máximo de emotes para mostrarlos en tamaño grande cuando el mensaje es solo emotes
const MAX_JUMBO = 30;

// Nodos del AST de Discord donde NO hay que reemplazar texto
const SKIP_NODE_TYPES = new Set([
    "inlineCode", "codeBlock", "link", "url", "autolink", "mailto", "tel",
    "mention", "roleMention", "channelMention", "commandMention", "staticRouteLink",
    "timestamp", "customEmoji", "emoji",
]);

interface SevenTVEmote {
    id: string;
    name: string;
    animated: boolean;
    zeroWidth: boolean;
    /** ancho/alto del archivo 1x, para respetar emotes anchos */
    width: number;
    height: number;
}

interface EmoteNode {
    type: "text";
    content: string;
    vc7tv: SevenTVEmote;
    vc7tvOverlays?: SevenTVEmote[];
    vc7tvJumbo?: boolean;
}

const settings = definePluginSettings({
    twitchUserId: {
        type: OptionType.STRING,
        description: "ID numérico del canal de Twitch cuyos emotes 7TV se van a usar",
        default: "92458848", // h0kd
        onChange: () => void loadEmotes(),
    },
    includeGlobalEmotes: {
        type: OptionType.BOOLEAN,
        description: "Incluir también los emotes globales de 7TV",
        default: false,
        onChange: () => void loadEmotes(),
    },
    ignoredEmotes: {
        type: OptionType.STRING,
        description: "Nombres separados por coma que NO se convierten (útil para palabras comunes)",
        default: "",
        onChange: () => void loadEmotes(),
    },
    refreshMinutes: {
        type: OptionType.NUMBER,
        description: "Cada cuántos minutos se recarga la lista de emotes (0 = nunca)",
        default: 30,
        onChange: () => scheduleRefresh(),
    },
    jumboEmotes: {
        type: OptionType.BOOLEAN,
        description: "Mostrar los emotes en grande cuando el mensaje es solo emotes",
        default: true,
    },
    pickerTab: {
        type: OptionType.BOOLEAN,
        description: "Agregar una pestaña \"7TV\" al selector de emojis para insertar los emotes con un clic (requiere reiniciar)",
        default: true,
        restartNeeded: true,
    },
});

type LoadState = "idle" | "loading" | "ok" | "error";

let emotes = new Map<string, SevenTVEmote>();
let loadState: LoadState = "idle";
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// Componentes montados (el panel del selector) que quieren enterarse cuando cambia la lista
const emoteListeners = new Set<() => void>();

function setEmotes(next: Map<string, SevenTVEmote>, state: LoadState) {
    emotes = next;
    loadState = state;
    for (const notify of emoteListeners) notify();
}

function useEmotes() {
    const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => {
        emoteListeners.add(forceUpdate);
        return () => void emoteListeners.delete(forceUpdate);
    }, []);
    return { emotes, loadState };
}

function parseEmoteList(list: any[] | undefined, out: Map<string, SevenTVEmote>) {
    for (const e of list ?? []) {
        const data = e?.data;
        if (!data?.host) continue;

        const file1x = data.host.files?.find((f: any) => f.name?.startsWith("1x")) ?? { width: 28, height: 28 };

        out.set(e.name, {
            id: e.id,
            name: e.name,
            animated: !!data.animated,
            zeroWidth: ((e.flags ?? 0) & ACTIVE_EMOTE_ZERO_WIDTH) !== 0 || ((data.flags ?? 0) & EMOTE_DATA_ZERO_WIDTH) !== 0,
            width: file1x.width,
            height: file1x.height,
        });
    }
}

async function loadEmotes() {
    const { twitchUserId, includeGlobalEmotes, ignoredEmotes } = settings.store;
    if (!twitchUserId?.trim()) {
        setEmotes(new Map(), "idle");
        return;
    }

    if (loadState !== "ok") setEmotes(emotes, "loading");

    try {
        const next = new Map<string, SevenTVEmote>();

        if (includeGlobalEmotes) {
            const res = await fetch(`${API_HOST}/v3/emote-sets/global`);
            if (res.ok) parseEmoteList((await res.json()).emotes, next);
        }

        // Los del canal van después para que tengan prioridad sobre los globales
        const res = await fetch(`${API_HOST}/v3/users/twitch/${encodeURIComponent(twitchUserId.trim())}`);
        if (!res.ok) throw new Error(`7TV respondió ${res.status}`);
        parseEmoteList((await res.json()).emote_set?.emotes, next);

        for (const name of ignoredEmotes.split(",").map(s => s.trim()).filter(Boolean))
            next.delete(name);

        setEmotes(next, "ok");
        logger.info(`Cargados ${emotes.size} emotes de 7TV`);
    } catch (err) {
        logger.error("No se pudieron cargar los emotes de 7TV", err);
        setEmotes(emotes, emotes.size ? "ok" : "error");
    }
}

function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;

    const minutes = settings.store.refreshMinutes;
    if (minutes > 0) refreshTimer = setInterval(loadEmotes, minutes * 60_000);
}

/** Pide permiso (una sola vez) para que Discord desktop permita cargar 7TV. */
async function ensureCspAccess() {
    // En el navegador (extensión) no existe esta API; ahí no hace falta
    const csp = (globalThis as any).VencordNative?.csp;
    if (!csp) return;

    try {
        const needs: [string, string[]][] = [
            [API_HOST, ["connect-src"]],
            [CDN_HOST, ["img-src"]],
        ];

        let changed = false;
        for (const [url, directives] of needs) {
            if (await csp.isDomainAllowed(url, directives)) continue;
            const result = await csp.requestAddOverride(url, directives, "SevenTVEmotes");
            if (result === "ok") changed = true;
        }

        if (changed) {
            Alerts.show({
                title: "SevenTVEmotes: reinicio necesario",
                body: "Se permitió cargar contenido desde 7TV. Reinicia Discord para que los emotes se muestren.",
                confirmText: "Reiniciar ahora",
                cancelText: "Después",
                onConfirm: relaunch,
            });
        }
    } catch (err) {
        logger.error("Error pidiendo acceso CSP", err);
    }
}

// ---------- Transformación del AST ----------

function isBlank(node: any) {
    return node?.type === "text" && typeof node.content === "string" && node.content.trim() === "" && !node.vc7tv;
}

function splitTextNode(node: any): any[] {
    const text: string = node.content;
    const parts = text.split(/(\s+)/);
    const out: any[] = [];
    let buffer = "";

    const flush = () => {
        if (buffer) out.push({ type: "text", content: buffer });
        buffer = "";
    };

    for (const part of parts) {
        const emote = part && !/^\s+$/.test(part) ? emotes.get(part) : undefined;
        if (!emote) {
            buffer += part;
            continue;
        }

        // Emote zero-width (p. ej. lluvia, sombrero): se superpone al emote anterior
        if (emote.zeroWidth) {
            const prevIdx = out.length - 1;
            if (!buffer.trim() && prevIdx >= 0 && out[prevIdx].vc7tv) {
                (out[prevIdx].vc7tvOverlays ??= []).push(emote);
                buffer = "";
                continue;
            }
        }

        flush();
        out.push({ type: "text", content: part, vc7tv: emote } satisfies EmoteNode);
    }
    flush();

    return out.length ? out : [node];
}

function transformNodes(nodes: any[]): any[] {
    const result: any[] = [];

    for (const node of nodes) {
        if (node == null || typeof node !== "object") {
            result.push(node);
            continue;
        }

        if (node.type === "text" && typeof node.content === "string" && !node.vc7tv) {
            result.push(...splitTextNode(node));
            continue;
        }

        if (!SKIP_NODE_TYPES.has(node.type)) {
            if (Array.isArray(node.content)) node.content = transformNodes(node.content);
            if (Array.isArray(node.items)) node.items = node.items.map((item: any) => Array.isArray(item) ? transformNodes(item) : item);
        }

        result.push(node);
    }

    return result;
}

function markJumbo(nodes: any[]) {
    if (!settings.store.jumboEmotes) return;

    const emoteNodes = nodes.filter(n => n?.vc7tv);
    if (!emoteNodes.length || emoteNodes.length > MAX_JUMBO) return;

    const onlyEmotes = nodes.every(n => n?.vc7tv || isBlank(n) || n?.type === "emoji" || n?.type === "customEmoji");
    if (onlyEmotes) for (const n of emoteNodes) n.vc7tvJumbo = true;
}

// ---------- Render en mensajes ----------

function emoteUrl(emote: SevenTVEmote, jumbo: boolean) {
    return `${CDN_HOST}/emote/${emote.id}/${jumbo ? "3x" : "2x"}.webp`;
}

function EmoteImage({ emote, jumbo, className }: { emote: SevenTVEmote; jumbo: boolean; className?: string; }) {
    const height = jumbo ? 48 : 22;
    const width = Math.round(height * (emote.width / emote.height || 1));

    return (
        <img
            className={className}
            src={emoteUrl(emote, jumbo)}
            alt={emote.name}
            draggable={false}
            loading="lazy"
            width={width}
            height={height}
        />
    );
}

function Emote({ node }: { node: EmoteNode; }) {
    const jumbo = !!node.vc7tvJumbo;
    const overlays = node.vc7tvOverlays ?? [];
    const label = [node.vc7tv.name, ...overlays.map(o => o.name)].join(" ");

    return (
        <Tooltip text={label}>
            {props => (
                <span
                    {...props}
                    className={`vc-7tv-emote${jumbo ? " vc-7tv-jumbo" : ""}`}
                >
                    <EmoteImage emote={node.vc7tv} jumbo={jumbo} />
                    {overlays.map(o => (
                        <EmoteImage key={o.id} emote={o} jumbo={jumbo} className="vc-7tv-overlay" />
                    ))}
                    <span className="vc-7tv-hidden-text">{label}</span>
                </span>
            )}
        </Tooltip>
    );
}

// ---------- Pestaña "7TV" del selector de emojis ----------

interface PickerProps {
    channel?: Channel;
    containerWidth?: number;
    closePopout: () => void;
}

function PickerEmptyState({ children }: { children: React.ReactNode; }) {
    return <div className="vc-7tv-picker-empty">{children}</div>;
}

function EmotePicker({ closePopout }: PickerProps) {
    const { emotes: all, loadState } = useEmotes();
    const [query, setQuery] = React.useState("");

    const list = React.useMemo(() => {
        const q = query.trim().toLowerCase();
        const arr = [...all.values()].filter(e => !q || e.name.toLowerCase().includes(q));
        return arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    }, [all, query]);

    const select = (emote: SevenTVEmote, ev: React.MouseEvent) => {
        insertTextIntoChatInputBox(emote.name + " ");
        // Igual que Discord: con Shift se pueden elegir varios sin cerrar el selector
        if (!ev.shiftKey) closePopout();
    };

    let content: React.ReactNode;
    if (!settings.store.twitchUserId?.trim()) {
        content = <PickerEmptyState>Configura el ID del canal de Twitch en Ajustes → Vencord → Plugins → SevenTVEmotes.</PickerEmptyState>;
    } else if (!all.size && loadState === "loading") {
        content = <PickerEmptyState>Cargando emotes de 7TV…</PickerEmptyState>;
    } else if (!all.size && loadState === "error") {
        content = (
            <PickerEmptyState>
                No se pudieron cargar los emotes de 7TV.{" "}
                <button className="vc-7tv-picker-retry" onClick={() => void loadEmotes()}>Reintentar</button>
            </PickerEmptyState>
        );
    } else if (!all.size) {
        content = <PickerEmptyState>Este canal no tiene emotes en 7TV.</PickerEmptyState>;
    } else if (!list.length) {
        content = <PickerEmptyState>No hay emotes que coincidan con "{query.trim()}".</PickerEmptyState>;
    } else {
        content = (
            <div className="vc-7tv-picker-grid" role="list">
                {list.map(emote => (
                    <Tooltip key={emote.id} text={emote.zeroWidth ? `${emote.name} (se superpone al emote anterior)` : emote.name}>
                        {props => (
                            <button
                                {...props}
                                role="listitem"
                                className="vc-7tv-picker-item"
                                aria-label={emote.name}
                                onClick={ev => select(emote, ev)}
                            >
                                <img src={emoteUrl(emote, false)} alt={emote.name} loading="lazy" draggable={false} />
                            </button>
                        )}
                    </Tooltip>
                ))}
            </div>
        );
    }

    return (
        <div className="vc-7tv-picker" id="vc-7tv-picker-tab-panel" role="tabpanel" aria-labelledby="vc-7tv-picker-tab">
            <div className="vc-7tv-picker-header">
                <TextInput
                    value={query}
                    onChange={setQuery}
                    placeholder="Buscar emote de 7TV"
                    autoFocus
                />
                <span className="vc-7tv-picker-count">{list.length} / {all.size}</span>
            </div>
            {content}
        </div>
    );
}

export default definePlugin({
    name: "SevenTVEmotes",
    description: "Muestra los emotes 7TV de un canal de Twitch en los mensajes de Discord y agrega una pestaña 7TV al selector de emojis (solo para quien tenga el plugin)",
    authors: [Devs.h0kd],
    settings,
    enabledByDefault: true,

    patches: [
        {
            // Renderizador del contenido de los mensajes: transforma el AST antes de pasarlo a React
            find: "hideSimpleEmbedContent:",
            replacement: {
                match: /let (\i)=(\i);return null!=(\i)&&\(\1=\3\(\1,(\i)\)\),\1/,
                replace: "let $1=$self.transformAst($2);return null!=$3&&($1=$3($1,$4)),$1"
            }
        },
        {
            // Regla "text" de las reglas React de Discord: si el nodo es un emote, lo dibujamos nosotros.
            // Si este patch falla, el emote simplemente se ve como texto normal.
            find: "silentPrefix:{react",
            replacement: {
                // (?<=[{,]) evita que coincida con "subtext:{react"
                match: /(?<=[{,])text:\{react:\((\i),(\i),(\i)\)=>/,
                replace: "text:{react:($1,$2,$3)=>$1.vc7tv!=null?$self.renderEmote($1,$3):"
            }
        },
        {
            // Selector de expresiones (GIF / Stickers / Emoji): agrega la pestaña "7TV" y su panel.
            // Los tres reemplazos van en grupo: si uno falla, no se aplica ninguno y el resto del plugin sigue andando.
            find: "#{intl::EXPRESSION_PICKER_CATEGORIES_A11Y_LABEL}",
            predicate: () => settings.store.pickerTab,
            group: true,
            replacement: [
                {
                    // Justo después de crear la pestaña "Emoji", creamos la nuestra con el mismo componente de pestaña
                    match: /\(0,\i\.jsx\)\((\i),\{id:\i\.\i,"aria-controls":\i\.\i,"aria-selected":(\i)===\i\.\i\.EMOJI,isActive:\2===\i\.\i\.EMOJI,viewType:\i\.\i\.EMOJI,children:\i\.intl\.string\(\i\.\i#{intl::EXPRESSION_PICKER_EMOJI}\)\}\)/,
                    replace: "$&,vc7tvTab=$self.renderTab($1,$2)"
                },
                {
                    // La agregamos a la lista de pestañas (después de GIF, Stickers y Emoji)
                    match: /role:"tablist","aria-label":\i\.intl\.string\(\i\.\i#{intl::EXPRESSION_PICKER_CATEGORIES_A11Y_LABEL}\),children:\[\i,\i,\i/,
                    replace: "$&,vc7tvTab"
                },
                {
                    // Y dibujamos nuestro panel cuando la vista activa es "7tv" (va antes del panel de stickers)
                    match: /(\i)===\i\.\i\.STICKER&&\i\?\(0,\i\.jsx\)\(\i,\{isLoading:\i,channel:(\i),containerWidth:(\i),onSelectSticker:\i,closePopout:(\i),/,
                    replace: `$1==="${PICKER_VIEW}"?$self.renderPicker({channel:$2,containerWidth:$3,closePopout:$4}):null,$&`
                }
            ]
        }
    ],

    transformAst(ast: any) {
        if (!emotes.size) return ast;

        try {
            if (Array.isArray(ast)) {
                const out = transformNodes(ast);
                markJumbo(out);
                return out;
            }
            return ast;
        } catch (err) {
            logger.error("Error transformando el mensaje", err);
            return ast;
        }
    },

    renderEmote(node: EmoteNode, state: { key?: string; }) {
        return <Emote key={state?.key} node={node} />;
    },

    renderTab(Tab: React.ComponentType<any>, activeView: string) {
        const active = activeView === PICKER_VIEW;
        return (
            <ErrorBoundary noop key="vc-7tv-picker-tab">
                <Tab
                    id="vc-7tv-picker-tab"
                    aria-controls="vc-7tv-picker-tab-panel"
                    aria-selected={active}
                    isActive={active}
                    viewType={PICKER_VIEW}
                >
                    7TV
                </Tab>
            </ErrorBoundary>
        );
    },

    renderPicker(props: PickerProps) {
        return (
            <ErrorBoundary key="vc-7tv-picker-panel">
                <EmotePicker {...props} />
            </ErrorBoundary>
        );
    },

    async start() {
        await ensureCspAccess();
        await loadEmotes();
        scheduleRefresh();
    },

    stop() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
        setEmotes(new Map(), "idle");
    },
});
