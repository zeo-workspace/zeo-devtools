// Every fixed sentence the panel page shows (story 055, design.md §A3, §Error Handling Strategy).
// Taken from zeo-browser/src/sidebar/text.ts (D6) without the extension's own states (native host,
// approval, follow, page tools) and without "Open in Zeo": the panel never raises Zeo (R7.5) and
// has no follow target (R5.7). "Open this project in Zeo to continue" asks the operator; no
// control here opens anything. The words are part of the requirements and the tests match them
// exactly, so they live in one place.
export const TEXT = {
  unreachable: "Zeo is not running, or its devtools bridge is off",
  tooOld: "This Zeo does not support the devtools panel",
  tooManyPanels: "Too many devtools panels are open — close one to continue",
  projectClosed: "Open this project in Zeo to continue",
  gone: "This thread is no longer available",
  pickerHeading: "Threads in this project",
  newThread: "New thread",
  noThreads: "No devtools threads in this project yet",
  untitled: "Untitled thread",
  aiDisabled: "AI is disabled in Zeo",
  queued: "Queued in Zeo",
  question: "The agent asked a question — answer it in Zeo",
  compaction: "Context compacted",
  // Zeo itself may end a cut entry with this sentence; the view then shows it once.
  truncated: "(truncated — open in Zeo for the rest)",
  noAnswer: "Zeo did not answer",
  refused: "The panel server refused the request",
  appWaiting: "Waiting for the dev server to say where the app is…",
  appUnavailable: "The dev server did not say where the app is; trying again",
  appSameOrigin:
    "The app is not shown: it has this panel's own origin, where the iframe's sandbox would not hold",
  appFrameTitle: "The app",
  openedByPage:
    "This devtools panel was opened by another page, so it does not connect. Open it from Zeo instead.",
  messageLabel: "Message to the agent",
  messagePlaceholder: "Message the agent — Enter sends, Shift+Enter adds a line",
} as const;

/** The reason Zeo gave for ending this panel's session (a fatal error). */
export const endedText = (reply: { error: string; message: string }): string =>
  `Zeo ended this panel's session: ${errorText(reply)}`;

/** The words an `error` message shows: Zeo's message, or the fixed text where one exists. */
export function errorText(reply: { error: string; message: string }): string {
  if (reply.error === "ai_disabled") {
    return TEXT.aiDisabled;
  }
  return reply.message || `Zeo answered ${reply.error}`;
}
