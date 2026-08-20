import { getClient, isConnected } from './opencodeClient';
import type { CatalogAgent, CatalogCommand, CatalogModel, ProviderContext, SessionUsage } from './webview/types';

/**
 * Owns the command/agent/model catalog plus the per-session agent/model
 * selections that prompts and server commands carry. Selections are seeded
 * from `session.get` on open and updated by the setAgent/setModel webview
 * messages; prompts/commands read them back via getAgent/getModel.
 */
export class MetaState {
  private readonly agentState = new Map<string, string>();
  private readonly modelState = new Map<string, { providerID: string; modelID: string }>();
  private readonly variantState = new Map<string, string>();
  private readonly contextLimitByModel = new Map<string, number>();
  private defaultModel?: { providerID: string; modelID: string };

  constructor(private readonly ctx: ProviderContext) {}

  getAgent(sessionId: string): string | undefined {
    return this.agentState.get(sessionId);
  }

  getModel(sessionId: string): { providerID: string; modelID: string } | undefined {
    return this.modelState.get(sessionId);
  }

  getVariant(sessionId: string): string | undefined {
    return this.variantState.get(sessionId);
  }

  /**
   * Loads the command/agent/model catalog and posts it to the webview. Fired
   * automatically on `ready` and again on `getCatalog` (refresh).
   */
  async loadCatalog(): Promise<void> {
    if (!isConnected()) {
      return;
    }
    try {
      const [commandsRes, agentsRes, providersRes, configRes] = await Promise.all([
        getClient().command.list(),
        getClient().app.agents(),
        getClient().config.providers(),
        // Best-effort: the full config carries the server's default agent.
        // Failure here must not sink the whole catalog.
        getClient().config.get().catch(() => undefined),
      ]);
      const commands: CatalogCommand[] = (commandsRes.data ?? [])
        .map((c) => ({ name: c.name, description: c.description, source: c.source }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const rawAgents = (agentsRes.data ?? []).filter((a) => a.hidden !== true);
      const agents: CatalogAgent[] = rawAgents.map((a) => ({ name: a.name, description: a.description }));
      // The server's default agent: explicit config, else the first primary
      // agent, else the first agent. Shown on the agent badge for sessions
      // with no explicit agent selection.
      const defaultAgent = configRes?.data?.default_agent ?? rawAgents.find((a) => a.mode === 'primary')?.name ?? rawAgents[0]?.name;
      const models: CatalogModel[] = [];
      for (const provider of providersRes.data?.providers ?? []) {
        for (const [modelID, model] of Object.entries(provider.models ?? {})) {
          models.push({
            providerID: provider.id,
            providerName: provider.name,
            modelID,
            modelName: model.name || model.id,
            ...(model.limit?.context !== undefined ? { contextLimit: model.limit.context } : {}),
            ...(model.variants && Object.keys(model.variants).length > 0 ? { variants: Object.keys(model.variants) } : {}),
          });
          if (model.limit?.context !== undefined) {
            this.contextLimitByModel.set(`${provider.id}/${modelID}`, model.limit.context);
          }
        }
      }
      let defaultModel: { providerID: string; modelID: string } | undefined;
      const defaults = providersRes.data?.default;
      const firstProvider = Object.keys(defaults ?? {})[0];
      if (firstProvider !== undefined && defaults !== undefined) {
        defaultModel = { providerID: firstProvider, modelID: defaults[firstProvider] };
      }
      this.defaultModel = defaultModel;
      this.ctx.post({
        type: 'catalog',
        commands,
        agents,
        models,
        ...(defaultModel !== undefined ? { defaultModel } : {}),
        ...(defaultAgent !== undefined ? { defaultAgent } : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.ctx.post({ type: 'error', message: `Failed to load catalog: ${detail}` });
    }
  }

  /**
   * Re-fetches a session and re-seeds the agent/model state maps from the
   * server's authoritative `session.agent` / `session.model`, then posts
   * `sessionMeta` to the webview. Called on selection, on `ready`, and after
   * `session.updated` SSE events for the active session.
   */
  async syncSessionMeta(sessionId: string): Promise<void> {
    if (!isConnected()) {
      return;
    }
    try {
      const res = await getClient().session.get({ sessionID: sessionId });
      const session = res.data;
      if (session === undefined) {
        return;
      }
      if (session.agent !== undefined) {
        this.agentState.set(sessionId, session.agent);
      } else {
        this.agentState.delete(sessionId);
      }
      if (session.model !== undefined) {
        this.modelState.set(sessionId, { providerID: session.model.providerID, modelID: session.model.id });
      } else {
        this.modelState.delete(sessionId);
      }
      if (session.model?.variant) {
        this.variantState.set(sessionId, session.model.variant);
      } else {
        this.variantState.delete(sessionId);
      }
      const model = session.model ?? this.defaultModel;
      const modelID = model ? ('id' in model ? model.id : model.modelID) : undefined;
      const contextLimit = model && modelID !== undefined ? this.contextLimitByModel.get(`${model.providerID}/${modelID}`) : undefined;
      const tokens = session.tokens;
      const usage: SessionUsage | undefined =
        session.cost !== undefined || tokens !== undefined
          ? {
              cost: session.cost ?? 0,
              contextTokens: tokens ? tokens.input + tokens.cache.read : 0,
              ...(contextLimit !== undefined ? { contextLimit } : {}),
            }
          : undefined;
      this.ctx.post({
        type: 'sessionMeta',
        sessionId,
        ...(session.agent !== undefined ? { agent: session.agent } : {}),
        ...(session.model !== undefined ? { model: { providerID: session.model.providerID, modelID: session.model.id } } : {}),
        ...(session.model?.variant ? { variant: session.model.variant } : {}),
        ...(usage !== undefined ? { usage } : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.ctx.post({ type: 'error', message: `Failed to load session metadata: ${detail}` });
    }
  }

  /** Handles a `setAgent` webview message. */
  handleSetAgent(message: Record<string, unknown>): void {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
    const agent = typeof message.agent === 'string' ? message.agent : undefined;
    if (sessionId === undefined || agent === undefined) {
      return;
    }
    this.agentState.set(sessionId, agent);
    const model = this.modelState.get(sessionId);
    const variant = this.variantState.get(sessionId);
    this.ctx.post({
      type: 'sessionMeta',
      sessionId,
      agent,
      ...(model !== undefined ? { model } : {}),
      ...(variant !== undefined ? { variant } : {}),
    });
  }

  /** Handles a `setModel` webview message. */
  handleSetModel(message: Record<string, unknown>): void {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
    const providerID = typeof message.providerID === 'string' ? message.providerID : undefined;
    const modelID = typeof message.modelID === 'string' ? message.modelID : undefined;
    if (sessionId === undefined || providerID === undefined || modelID === undefined) {
      return;
    }
    this.modelState.set(sessionId, { providerID, modelID });
    // Variants are model-specific — a model change invalidates the selection.
    this.variantState.delete(sessionId);
    const agent = this.agentState.get(sessionId);
    const variant = this.variantState.get(sessionId);
    this.ctx.post({
      type: 'sessionMeta',
      sessionId,
      model: { providerID, modelID },
      ...(agent !== undefined ? { agent } : {}),
      ...(variant !== undefined ? { variant } : {}),
    });
  }

  /** Handles a `setVariant` webview message. */
  handleSetVariant(message: Record<string, unknown>): void {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
    const variant = typeof message.variant === 'string' ? message.variant : undefined;
    if (sessionId === undefined || variant === undefined) {
      return;
    }
    if (variant === '') {
      this.variantState.delete(sessionId);
    } else {
      this.variantState.set(sessionId, variant);
    }
    const agent = this.agentState.get(sessionId);
    const model = this.modelState.get(sessionId);
    const current = this.variantState.get(sessionId);
    this.ctx.post({
      type: 'sessionMeta',
      sessionId,
      ...(current !== undefined ? { variant: current } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  }
}
