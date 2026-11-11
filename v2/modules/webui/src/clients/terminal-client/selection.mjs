export function createTerminalSelection({ resolveAdmission, openStream }) {
  let generation = 0;
  let admission = null;
  let stream = null;

  function closeCurrentStream() {
    if (stream) {
      stream.close();
      stream = null;
    }
  }

  return {
    async select(target, handlers = {}) {
      const selection = ++generation;
      closeCurrentStream();
      admission = null;

      let nextAdmission = null;
      let resolveError = null;
      try {
        nextAdmission = await resolveAdmission(target);
      } catch (error) {
        resolveError = error;
      }

      if (selection !== generation) {
        return null;
      }
      if (!nextAdmission) {
        return { target, admission: null, error: resolveError };
      }

      admission = nextAdmission;
      handlers.onAdmission?.(nextAdmission);
      stream = openStream(nextAdmission, {
        onReady: () => {
          if (selection === generation) {
            handlers.onReady?.();
          }
        },
        onBuffer: (payload) => {
          if (selection === generation) {
            handlers.onBuffer?.(payload);
          }
        },
        onError: (error) => {
          if (selection === generation) {
            handlers.onError?.(error);
          }
        },
      });
      return { target, admission: nextAdmission, stream };
    },

    close() {
      generation += 1;
      closeCurrentStream();
      admission = null;
    },

    getAdmission() {
      return admission;
    },
  };
}
