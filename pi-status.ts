/**
 * Pi Status Extension
 *
 * Shows a green checkmark (✅) in the **terminal title** when pi is idle
 * (session finished, waiting for user input). When the user submits
 * a prompt, the checkmark becomes a braille-dot spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏).
 *
 * Context-usage percentage appears beside the checkmark (idle state) in the title:
 *   ≤ 50%  → not shown
 *   > 50%  → [N%]   (e.g. ✅ [63%] 🟢 project)
 *   ≥ 90%  → ![N%]!  (e.g. ✅ ![95%]! 🟢 project)
 * The percentage is captured once when the checkmark is shown; the spinner never displays it.
 *
 * Usage:
 *   pi -e ./pi-status.ts
 *   # Or place in ~/.pi/agent/extensions/pi-status.ts for auto-discovery
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** First grapheme of PI_AGENT_NAME, e.g. "🟢", falling back to "π" */
const AGENT = Array.from(process.env.PI_AGENT_NAME || "π")[0];

const DEBUG = process.env.PI_STATUS_DEBUG === "1";
function log(msg: string) {
	if (DEBUG) console.error(`[pi-status] ${msg}`);
}

/** Direct OSC title set as fallback for terminals where pi API setTitle doesn't work (e.g., GitBash/Windows Terminal) */
function setTitleDirect(title: string) {
	try {
		// OSC 2: set window title; BEL (\007) terminates
		process.stdout.write(`\x1b]2;${title}\x07`);
	} catch {
		// ignore
	}
}

function getBaseTitle(pi: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = pi.getSessionName();
	return session ? `${AGENT} ${session} - ${cwd}` : `${AGENT} ${cwd}`;
}

function getContextIndicator(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const percent = usage?.percent ?? null;
	if (!(percent > 50)) return "";
	const pct = Math.round(percent);
	const formatted = `[${pct}%]`;
	return ` ${percent >= 90 ? `!${formatted}!` : formatted}`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;
	// Latest context seen by any handler; the spinner interval must not keep
	// using a stale context captured at spinner start.
	let currentCtx: ExtensionContext | null = null;
	let sessionStarted = false;

	// A throwing setTitle (or title computation) inside the interval callback
	// would kill the timer and freeze the title forever — always catch.
	function safeSetTitle(ctx: ExtensionContext, title: string) {
		try {
			ctx.ui.setTitle(title);
			// Also write directly to stdout as fallback for terminals where pi API doesn't propagate the title
			setTitleDirect(title);
		} catch (err) {
			console.error("[pi-status] setTitle failed:", err);
			// Fallback: try direct write even if pi API threw
			setTitleDirect(title);
		}
	}

	function stopSpinner() {
		if (timer) { clearInterval(timer); timer = null; log("spinner stopped"); }
		frameIndex = 0;
	}

	function restoreTitle(ctx: ExtensionContext) {
		log("restoring idle title");
		try {
			const title = `✅${getContextIndicator(ctx)} ${getBaseTitle(pi)}`;
			safeSetTitle(ctx, title);
		} catch (err) {
			console.error("[pi-status] restore failed:", err);
			// Last resort: try direct write with basic title
			try {
				setTitleDirect(`✅ ${getBaseTitle(pi)}`);
			} catch {
				// ignore
			}
		}
	}

	function showSpinnerFrame() {
		const ctx = currentCtx;
		if (!ctx) return;
		try {
			const title = `${SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length]} ${getBaseTitle(pi)}`;
			safeSetTitle(ctx, title);
		} catch (err) {
			console.error("[pi-status] spinner frame failed:", err);
		}
		frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
	}

	function startSpinner(ctx: ExtensionContext) {
		currentCtx = ctx;
		if (timer) { frameIndex = 0; return; }
		frameIndex = 0;
		showSpinnerFrame();
		timer = setInterval(showSpinnerFrame, 2000);
		(timer as any).unref?.();
		log("spinner started");
	}

	function ensureSessionStarted(ctx: ExtensionContext) {
		if (!sessionStarted) {
			sessionStarted = true;
			currentCtx = ctx;
			// Do NOT schedule restoreTitle here — only session_start (deferred) and agent_end should restore idle title.
			// This avoids a race where input fires before session_start and causes an unwanted idle title flash.
		}
	}

	pi.on("session_start", (_e, ctx) => {
		stopSpinner(); // clear any interval leaked from a previous session
		currentCtx = ctx;
		sessionStarted = true;
		// Defer to let pi's init-based updateTerminalTitle() fire first
		setImmediate(() => restoreTitle(ctx));
	});

	pi.on("input", (_e, ctx) => {
		ensureSessionStarted(ctx);
		startSpinner(ctx);
	});

	pi.on("agent_start", (_e, ctx) => {
		ensureSessionStarted(ctx);
		startSpinner(ctx);
	});

	pi.on("turn_start", (_e, ctx) => {
		ensureSessionStarted(ctx);
		startSpinner(ctx);
	});

	pi.on("agent_end", (_e, ctx) => {
		currentCtx = ctx;
		stopSpinner();
		restoreTitle(ctx);
	});

	pi.on("session_shutdown", (_e, ctx) => {
		stopSpinner();
		safeSetTitle(ctx, getBaseTitle(pi));
		sessionStarted = false;
	});
}