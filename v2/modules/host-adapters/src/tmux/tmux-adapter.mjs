import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TypedError } from "../../../errors/src/typed-error.mjs";

const execFileAsync = promisify(execFile);

export class TmuxAdapter {
  constructor({ socketName = "zterm-v2-i0", tmuxBin = "tmux" } = {}) {
    this.socketName = socketName;
    this.tmuxBin = tmuxBin;
  }

  async listSessions() {
    try {
      const { stdout } = await this.run([
        "list-sessions",
        "-F",
        "#{session_id}|#{session_name}|#{session_created}|#{session_attached}|#{session_windows}",
      ]);

      return stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const fields = line.split("|");
          if (fields.length < 5) {
            throw new Error(`Unexpected tmux session record: ${line}`);
          }
          const id = fields[0];
          const name = fields.slice(1, -3).join("|");
          const createdAt = fields.at(-3);
          const attached = fields.at(-2);
          const windows = fields.at(-1);
          return {
            id,
            name,
            createdAt: Number(createdAt),
            createdIso: new Date(Number(createdAt) * 1000).toISOString(),
            attached: attached === "1",
            windows: Number(windows),
          };
        });
    } catch (error) {
      if (isMissingServer(error)) {
        return [];
      }
      throw mapTmuxError(error, "listSessions", null, this.socketName);
    }
  }

  async capture(target) {
    try {
      const { stdout } = await this.run(["capture-pane", "-p", "-t", target]);
      return stdout;
    } catch (error) {
      throw mapTmuxError(error, "capture", target, this.socketName);
    }
  }

  async sendKeys(target, data) {
    if (typeof data !== "string" || data.length === 0 || data.includes("\0")) {
      throw new TypedError({
        code: "INPUT_INVALID",
        owningModule: "host-adapters",
        operationId: "sendKeys",
        cause: "Input must be a non-empty string without NUL bytes.",
        message: "Terminal input is invalid.",
      });
    }

    try {
      await this.run(["send-keys", "-t", target, "-l", "--", data]);
      await this.run(["send-keys", "-t", target, "Enter"]);
      return {
        target,
        source: "tmux",
        deliveredAt: new Date().toISOString(),
      };
    } catch (error) {
      throw mapTmuxError(error, "sendKeys", target, this.socketName);
    }
  }

  async createSession(name) {
    try {
      await this.run(["new-session", "-d", "-s", name]);
      return { name, source: "tmux" };
    } catch (error) {
      throw mapTmuxError(error, "createSession", name, this.socketName);
    }
  }

  async run(args) {
    return execFileAsync(this.tmuxBin, ["-L", this.socketName, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  }
}

function isMissingServer(error) {
  const detail = String(error.stderr || error.message);
  return /no server running|error connecting to .*No such file or directory/i.test(detail);
}

function mapTmuxError(error, operationId, target, socketName) {
  const detail = String(error.stderr || error.message || error).trim();
  const targetMissing = /can't find (session|pane)|no such session|invalid target|target .* not found/i.test(detail);

  return new TypedError({
    code: targetMissing ? "TARGET_NOT_FOUND" : "TMUX_COMMAND_FAILED",
    owningModule: "host-adapters",
    operationId,
    cause: {
      socketName,
      target,
      detail,
    },
    message: targetMissing ? "Terminal target was not found." : "tmux command failed.",
  });
}
