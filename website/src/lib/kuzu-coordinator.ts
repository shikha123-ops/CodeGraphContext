// website/src/lib/kuzu-coordinator.ts
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type QueryExecutionCallback = (
  queryType: string,
  target: string,
  params: any
) => Promise<any>;

export type ToolsListCallback = () => Promise<any[]>;

export type ToolCallCallback = (
  toolName: string,
  args: any
) => Promise<any>;

export class KuzuCoordinator {
  private supabase: SupabaseClient;
  private channelName: string;
  private channel: any = null;
  private globalChannel: any = null;
  
  private executeQueryCallback: QueryExecutionCallback;
  private getToolsCallback: ToolsListCallback;
  private executeToolCallback: ToolCallCallback;
  
  private isSubscribed = false;

  constructor(
    supabaseUrl: string,
    supabaseAnonKey: string,
    channelName: string,
    executeQueryCallback: QueryExecutionCallback,
    getToolsCallback: ToolsListCallback,
    executeToolCallback: ToolCallCallback
  ) {
    if (!supabaseUrl || !supabaseAnonKey) {
      console.warn("[KuzuCoordinator] Missing Supabase configuration credentials.");
    }
    this.supabase = createClient(supabaseUrl, supabaseAnonKey);
    this.channelName = channelName;
    this.executeQueryCallback = executeQueryCallback;
    this.getToolsCallback = getToolsCallback;
    this.executeToolCallback = executeToolCallback;
  }

  /**
   * Subscribes to the real-time signaling channels and listens for queries/MCP events.
   */
  public start() {
    if (this.isSubscribed) return;

    console.log(`[KuzuCoordinator] Subscribing to query channel: ${this.channelName}`);
    this.channel = this.supabase.channel(this.channelName);

    // 1. Listen for standard query requests and MCP tool calls on the repo channel
    this.channel
      .on(
        "broadcast",
        { event: "query-request" },
        async ({ payload }: { payload: any }) => {
          const { id, queryType, target, params } = payload || {};
          if (!id) return;
          console.log(`[KuzuCoordinator] 📥 Query request received: id=${id}, type=${queryType}`);
          try {
            const result = await this.executeQueryCallback(queryType, target, params);
            await this.channel.send({
              type: "broadcast",
              event: "query-response",
              payload: { id, status: "success", result }
            });
          } catch (err: any) {
            await this.channel.send({
              type: "broadcast",
              event: "query-response",
              payload: { id, status: "error", error: err.message }
            });
          }
        }
      )
      .on(
        "broadcast",
        { event: "tool-call-request" },
        async ({ payload }: { payload: any }) => {
          const { id, toolName, args } = payload || {};
          if (!id || !toolName) return;
          console.log(`[KuzuCoordinator] 📥 MCP Tool Call request received: id=${id}, name=${toolName}`);
          try {
            const result = await this.executeToolCallback(toolName, args);
            await this.channel.send({
              type: "broadcast",
              event: "tool-call-response",
              payload: { id, status: "success", result }
            });
          } catch (err: any) {
            await this.channel.send({
              type: "broadcast",
              event: "tool-call-response",
              payload: { id, status: "error", error: err.message }
            });
          }
        }
      )
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          console.log(`[KuzuCoordinator] ✅ Subscribed to query channel: ${this.channelName}`);
        }
      });

    // 2. Listen for tools list queries on the global channel
    const globalChannelName = "cgc-tunnel-global-mcp";
    console.log(`[KuzuCoordinator] Subscribing to global channel: ${globalChannelName}`);
    this.globalChannel = this.supabase.channel(globalChannelName);

    this.globalChannel
      .on(
        "broadcast",
        { event: "tools-list-request" },
        async ({ payload }: { payload: any }) => {
          const { id } = payload || {};
          if (!id) return;
          console.log(`[KuzuCoordinator] 📥 Tools List request received: id=${id}`);
          try {
            const tools = await this.getToolsCallback();
            await this.globalChannel.send({
              type: "broadcast",
              event: "tools-list-response",
              payload: { id, status: "success", tools }
            });
          } catch (err: any) {
            await this.globalChannel.send({
              type: "broadcast",
              event: "tools-list-response",
              payload: { id, status: "error", error: err.message }
            });
          }
        }
      )
      .on(
        "broadcast",
        { event: "tool-call-request" },
        async ({ payload }: { payload: any }) => {
          const { id, toolName, args } = payload || {};
          if (!id || !toolName) return;
          console.log(`[KuzuCoordinator] 📥 Global MCP Tool Call request received: id=${id}, name=${toolName}`);
          try {
            const result = await this.executeToolCallback(toolName, args);
            await this.globalChannel.send({
              type: "broadcast",
              event: "tool-call-response",
              payload: { id, status: "success", result }
            });
          } catch (err: any) {
            await this.globalChannel.send({
              type: "broadcast",
              event: "tool-call-response",
              payload: { id, status: "error", error: err.message }
            });
          }
        }
      )
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          this.isSubscribed = true;
          console.log(`[KuzuCoordinator] ✅ Subscribed to global channel: ${globalChannelName}`);
        }
      });
  }

  /**
   * Cleans up channel subscriptions and disconnects the signaling tunnels.
   */
  public stop() {
    if (this.channel) {
      console.log(`[KuzuCoordinator] Unsubscribing from query tunnel: ${this.channelName}`);
      this.supabase.removeChannel(this.channel);
      this.channel = null;
    }
    if (this.globalChannel) {
      console.log(`[KuzuCoordinator] Unsubscribing from global tools tunnel`);
      this.supabase.removeChannel(this.globalChannel);
      this.globalChannel = null;
    }
    this.isSubscribed = false;
  }
}
