import { readSelectedText } from '../shared/selected-text.ts';

type SideChats = {
  getSnapshot(): Record<string, { childId?: string } | undefined>;
  open(owner: string): Promise<{ childId: string }>;
  owns(owner: string, childId: string): boolean;
  close(owner: string, childId: string): Promise<unknown>;
};

export interface QuoteContext {
  get(name: string): any;
  sidebarRight: { mounted: { getSnapshot(): string | undefined } };
  sessions: { scope(id: string): unknown };
  conversation: { input: { for(scope: unknown): { insertQuote(text: string): boolean; focus(): void } } };
}

/** Route a captured selection through the native quote editor, without submitting. */
export async function insertSelectionQuote(ctx: QuoteContext, waitForInput: (id: string, owner: string) => Promise<unknown>, request: {
  target: 'main' | 'side'; owner: string; sourceId: string; text: string;
}): Promise<string> {
  const { target, owner, sourceId } = request;
  const { text } = readSelectedText(JSON.stringify({ text: request.text, source: '' }));
  const chats: SideChats | undefined = target === 'side' || sourceId !== owner ? ctx.get('sideChats') : undefined;
  const checkOwner = () => {
    if (ctx.sidebarRight.mounted.getSnapshot() !== owner || sourceId !== owner && !chats?.owns(owner, sourceId)) {
      throw new Error('会话或面板已切换，请重新选择内容。');
    }
  };
  let opened: { id: string; fresh: boolean } | undefined;
  try {
    checkOwner();
    let id = owner;
    if (target === 'side') {
      if (!chats) throw new Error('请先启用新版侧聊插件，再使用“在侧边聊天中提问”。');
      const previous = chats.getSnapshot()[owner]?.childId;
      id = (await chats.open(owner)).childId;
      opened = { id, fresh: previous !== id };
    }
    await waitForInput(id, owner);
    checkOwner();
    if (target === 'side' && !chats?.owns(owner, id)) throw new Error('侧聊已关闭，请重新选择内容。');
    const scope = ctx.sessions.scope(id);
    if (!scope) throw new Error('目标输入框尚未就绪，请稍后重试。');
    const input = ctx.conversation.input.for(scope);
    if (!input.insertQuote(text)) throw new Error('输入框正在提交或内容已变化，请重试；原草稿已保留。');
    input.focus();
    return id;
  } catch (reason) {
    if (opened?.fresh && ctx.sidebarRight.mounted.getSnapshot() !== owner && chats?.owns(owner, opened.id)) {
      await chats.close(owner, opened.id);
    }
    throw reason;
  }
}
