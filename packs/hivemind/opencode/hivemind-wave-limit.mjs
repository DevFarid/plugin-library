const maxParallel = 0;

export default {
  id: "hivemind.wave-limit",
  async setup(ctx) {
    if (maxParallel < 1 || maxParallel > 12) {
      throw new Error("Hivemind wave limit must be between 1 and 12.");
    }

    // On OpenCode 2.2, the runner awaits all foreground calls before the next model step.
    const sessionWaves = new Map();
    await ctx.tool.hook("execute.before", (event) => {
      if (event.agent !== "hivemind-architect" || event.tool !== "subagent") return;
      if (event.input.background === true) {
        throw new Error("Hivemind waves require foreground calls in one assistant message.");
      }

      let wave = sessionWaves.get(event.sessionID);
      if (wave?.messageID !== event.messageID) {
        sessionWaves.delete(event.sessionID);
        if (sessionWaves.size >= 1024) {
          sessionWaves.delete(sessionWaves.keys().next().value);
        }
        wave = { messageID: event.messageID, calls: new Set() };
        sessionWaves.set(event.sessionID, wave);
      }

      if (wave.calls.has(event.id)) return;
      if (wave.calls.size >= maxParallel) {
        throw new Error(`Hivemind permits up to ${maxParallel} subagent calls in one assistant message.`);
      }
      wave.calls.add(event.id);
    });
  },
};
