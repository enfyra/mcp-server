export type ClientKey = 'codex' | 'claude' | 'cursor' | 'vscode' | 'antigravity' | 'zcode';

export type ChoiceClientKey = ClientKey | 'all';

export type ClientSelection = Record<ClientKey, boolean>;

export type McpConfigToolMode = 'preserve' | 'compact' | 'static';

export type McpServerEntryOptions = {
  toolMode?: McpConfigToolMode;
};

export type ParsedArgs = ClientSelection & {
  appUrl?: string;
  apiToken?: string;
  help: boolean;
  yes: boolean;
  reconfig: boolean;
  targetExplicit: boolean;
  toolMode: McpConfigToolMode;
};

export type ExistingEnv = {
  apiUrl: string;
  apiToken: string;
};

export type TargetChoice = {
  client: ChoiceClientKey;
  value: ClientSelection;
};

export type KeypressInfo = {
  ctrl?: boolean;
  name?: string;
};
