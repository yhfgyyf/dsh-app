import { Component, createRef, useLayoutEffect, useRef, useState } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';

type ClosingReply = {
  turn: number;
  step: number;
  blocks: readonly { kind: string; text?: string }[];
  finalNode: { seq: number; messageId?: string };
};
type Props = {
  seq: number;
  turn: { data: { get(key: 'turn-tail'): { closing: ClosingReply | null; branchUnavailable: boolean } | undefined } };
};

const labels = { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '参考资料' };

function visibleContent(element: HTMLElement) {
  const visible = typeof element.checkVisibility === 'function'
    ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    : getComputedStyle(element).visibility === 'visible';
  return visible && element.getBoundingClientRect().height > 0
    && (!!element.textContent?.trim() || !!element.querySelector('img, svg, canvas, hr'));
}

// Keep the original source readable even when Markdown itself fails on the older renderer.
class RecoveredReply extends Component<{ text: string }, { plain: boolean }> {
  state = { plain: false };
  private body = createRef<HTMLDivElement>();
  static getDerivedStateFromError() { return { plain: true }; }
  componentDidMount() {
    const markdown = this.body.current?.firstElementChild;
    if (!this.state.plain && (!(markdown instanceof HTMLElement) || !visibleContent(markdown))) {
      this.setState({ plain: true });
    }
  }
  render() {
    const { text } = this.props;
    return <div ref={this.body} data-desktop-recovered-reply="" data-text-interaction-source="">
      {this.state.plain ? <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</div>
        : <MarkdownText text={text} labels={labels} />}
    </div>;
  }
}

function ClosingReplyView({ closing }: { closing: ClosingReply }) {
  const marker = useRef<HTMLSpanElement>(null);
  const [missing, setMissing] = useState(false);
  useLayoutEffect(() => {
    const flow = marker.current?.closest<HTMLElement>('[data-chat-flow]');
    if (!flow) return;
    const container = flow;
    // The core keys each assistant step by its turn and step. A reasoning-only copy
    // of the same node can also be present when the work details are expanded.
    const selector = `[data-chat-turn="${closing.turn}"][data-chat-flow-kind="assistant-step"][data-chat-node-key$=":${closing.step}"]:not([data-chat-group-part="reasoning"])`;
    let watched: HTMLElement | null | undefined;
    const resize = new ResizeObserver(check);
    const changes = new MutationObserver(check);
    function check() {
      const row = container.querySelector<HTMLElement>(selector);
      if (row !== watched) {
        watched = row;
        changes.disconnect();
        resize.disconnect();
        const target = row ?? container;
        resize.observe(target);
        changes.observe(target, { childList: true, subtree: true, attributes: !!row, characterData: !!row });
      }
      const bodies = row?.querySelectorAll<HTMLElement>('[data-text-interaction-source]') ?? [];
      setMissing(!Array.from(bodies).some(body => !body.closest('[data-turn-process-inline]') && visibleContent(body)));
    }
    check();
    return () => { changes.disconnect(); resize.disconnect(); };
  }, [closing.turn, closing.step, closing.finalNode.seq]);
  const text = missing ? closing.blocks.filter(block => block.kind === 'text').map(block => block.text).join('') : '';
  return <><span hidden ref={marker} />{text && <RecoveredReply text={text} />}</>;
}

/** The same finalized reply used by Copy, independently of the work-details rows. */
export function KylinChatReply({ turn, seq }: Props) {
  const tail = turn.data.get('turn-tail');
  const closing = tail?.closing;
  if (!closing?.finalNode.messageId || closing.finalNode.seq !== seq || tail?.branchUnavailable) return null;
  return <ClosingReplyView key={seq} closing={closing} />;
}
