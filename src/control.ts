import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Shared between the extension (writer) and the MCP server (reader).
// Holds the per-workspace enable/disable state so Claude's use of DeepSeek
// can be turned off for individual projects without touching global config.

const CONTROL_FILE = path.join(os.homedir(), '.claude', 'deepseek-bridge-control.json');

interface Control { disabledWorkspaces: string[]; }

/** Canonical, case-insensitive key for a workspace path (Windows-friendly). */
export function norm(p: string): string {
    if (!p) return '';
    return path.resolve(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function read(): Control {
    try {
        const c = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
        return { disabledWorkspaces: Array.isArray(c.disabledWorkspaces) ? c.disabledWorkspaces : [] };
    } catch {
        return { disabledWorkspaces: [] };
    }
}

function write(c: Control): void {
    fs.mkdirSync(path.dirname(CONTROL_FILE), { recursive: true });
    fs.writeFileSync(CONTROL_FILE, JSON.stringify(c, null, 2), 'utf8');
}

/** Default is ENABLED — a workspace is off only if explicitly listed. */
export function isWorkspaceEnabled(wsPath: string): boolean {
    if (!wsPath) return true;
    const key = norm(wsPath);
    return !read().disabledWorkspaces.map(norm).includes(key);
}

export function setWorkspaceEnabled(wsPath: string, enabled: boolean): void {
    if (!wsPath) return;
    const c = read();
    const key = norm(wsPath);
    const set = new Set(c.disabledWorkspaces.map(norm));
    if (enabled) set.delete(key); else set.add(key);
    c.disabledWorkspaces = [...set];
    write(c);
}
