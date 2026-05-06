export type ChatCommandResult =
  | { ok: true; content: string }
  | { ok: true; action: "status"; status: "online" | "idle" | "dnd" }
  | { ok: true; action: "dm"; target: string }
  | { ok: true; action: "call"; target: string }
  | { ok: true; action: "invite"; target: string }
  | { ok: true; action: "mute" | "deafen" | "help" }
  | { ok: true; action: "search"; query: string }
  | {
      ok: false;
      errorKey:
        | "pollUsage"
        | "pollOptionCount"
        | "statusUsage"
        | "dmUsage"
        | "callUsage"
        | "inviteUsage"
        | "meUsage"
        | "searchUsage";
    };

export type ChatCommand = {
  name: string;
  usage: string;
  descriptionKey: string;
};

export type CommandOption = {
  value: string;
  usage: string;
  descriptionKey: string;
};

export type CommandOptionContext =
  | { type: "none" }
  | { type: "status"; query: string }
  | { type: "member"; command: "dm" | "call" | "invite"; query: string };

export const CHAT_COMMANDS: ChatCommand[] = [
  {
    name: "help",
    usage: "/help",
    descriptionKey: "commandHelpDescription",
  },
  {
    name: "mute",
    usage: "/mute",
    descriptionKey: "commandMuteDescription",
  },
  {
    name: "deafen",
    usage: "/deafen",
    descriptionKey: "commandDeafenDescription",
  },
  {
    name: "search",
    usage: "/search query",
    descriptionKey: "commandSearchDescription",
  },
  {
    name: "me",
    usage: "/me action",
    descriptionKey: "commandMeDescription",
  },
  {
    name: "shrug",
    usage: "/shrug",
    descriptionKey: "commandShrugDescription",
  },
  {
    name: "status",
    usage: "/status online | idle | dnd",
    descriptionKey: "commandStatusDescription",
  },
  {
    name: "dm",
    usage: "/dm @username",
    descriptionKey: "commandDMDescription",
  },
  {
    name: "call",
    usage: "/call @username",
    descriptionKey: "commandCallDescription",
  },
  {
    name: "invite",
    usage: "/invite @username",
    descriptionKey: "commandInviteDescription",
  },
  {
    name: "poll",
    usage: '/poll "Question" "Option A" "Option B"',
    descriptionKey: "commandPollDescription",
  },
];

const numberLabels = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const shrug = String.raw`¯\_(ツ)_/¯`;

export const STATUS_OPTIONS: CommandOption[] = [
  {
    value: "online",
    usage: "/status online",
    descriptionKey: "statusOnlineDescription",
  },
  {
    value: "idle",
    usage: "/status idle",
    descriptionKey: "statusIdleDescription",
  },
  {
    value: "dnd",
    usage: "/status dnd",
    descriptionKey: "statusDndDescription",
  },
];

export function isChatCommand(content: string): boolean {
  return content.trimStart().startsWith("/");
}

export function getCommandQuery(content: string): string | null {
  const trimmedStart = content.trimStart();
  if (!trimmedStart.startsWith("/")) return null;

  const firstLine = trimmedStart.split("\n", 1)[0];
  return firstLine.slice(1).toLowerCase();
}

export function hasCommandSuggestion(query: string | null): boolean {
  if (query === null) return false;
  return getCommandSuggestions(query).length > 0 || getCommandOptions(query).length > 0;
}

export function getCommandSuggestions(query: string): ChatCommand[] {
  const commandName = query.trimStart().split(/\s+/, 1)[0] ?? "";
  if (query.includes(" ")) return [];
  return CHAT_COMMANDS.filter((command) => command.name.startsWith(commandName));
}

export function getCommandOptions(query: string): CommandOption[] {
  const context = getCommandOptionContext(query);
  if (context.type !== "status") return [];

  return STATUS_OPTIONS.filter((option) => option.value.startsWith(context.query));
}

export function getCommandOptionContext(query: string): CommandOptionContext {
  const trimmed = query.trimStart();
  const [commandName, ...args] = trimmed.split(/\s+/);
  if (!query.includes(" ")) return { type: "none" };

  if (commandName === "status") {
    return { type: "status", query: args.join(" ").trim().toLowerCase() };
  }

  if (commandName === "dm" || commandName === "call" || commandName === "invite") {
    return {
      type: "member",
      command: commandName,
      query: args.join(" ").trim().replace(/^@/, "").toLowerCase(),
    };
  }

  return { type: "none" };
}

export function executeChatCommand(content: string): ChatCommandResult | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) return null;

  const match = trimmed.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const commandName = match[1].toLowerCase();
  const args = match[2]?.trim() ?? "";

  switch (commandName) {
    case "poll":
      return buildPollMessage(args);
    case "me":
      return buildMeMessage(args);
    case "shrug":
      return { ok: true, content: args ? `${args} ${shrug}` : shrug };
    case "mute":
    case "deafen":
    case "help":
      return { ok: true, action: commandName };
    case "search":
      return buildSearchAction(args);
    case "status":
      return buildStatusAction(args);
    case "dm":
      return buildTargetAction("dm", args);
    case "call":
      return buildTargetAction("call", args);
    case "invite":
      return buildTargetAction("invite", args);
    default:
      return null;
  }
}

function buildMeMessage(args: string): ChatCommandResult {
  const action = args.trim();
  if (!action) {
    return { ok: false, errorKey: "meUsage" };
  }

  return { ok: true, content: `* ${action}` };
}

function buildSearchAction(args: string): ChatCommandResult {
  const query = args.trim();
  if (!query) {
    return { ok: false, errorKey: "searchUsage" };
  }

  return { ok: true, action: "search", query };
}

function buildPollMessage(args: string): ChatCommandResult {
  const parts = parsePollArgs(args);
  if (parts.length < 3) {
    return { ok: false, errorKey: "pollUsage" };
  }

  const [question, ...options] = parts;
  if (options.length < 2 || options.length > numberLabels.length) {
    return { ok: false, errorKey: "pollOptionCount" };
  }

  const lines = [
    `POLL: ${question}`,
    "",
    ...options.map((option, index) => `${numberLabels[index]}. ${option}`),
    "",
    "Vote by reacting with the option number.",
  ];

  return { ok: true, content: lines.join("\n") };
}

function parsePollArgs(args: string): string[] {
  if (!args) return [];

  const quoted = [...args.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (quoted.length > 0) return quoted;

  return args
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildStatusAction(args: string): ChatCommandResult {
  const status = args.trim().toLowerCase();
  if (status !== "online" && status !== "idle" && status !== "dnd") {
    return { ok: false, errorKey: "statusUsage" };
  }

  return { ok: true, action: "status", status };
}

function buildTargetAction(action: "dm" | "call" | "invite", args: string): ChatCommandResult {
  const target = args.trim().split(/\s+/, 1)[0]?.replace(/^@/, "") ?? "";
  if (!target) {
    const errorKey =
      action === "dm" ? "dmUsage" : action === "call" ? "callUsage" : "inviteUsage";
    return { ok: false, errorKey };
  }

  return { ok: true, action, target };
}
