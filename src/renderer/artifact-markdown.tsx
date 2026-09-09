import { useEffect, useMemo, useState } from 'react';
import type { ComponentProps } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';

/** The chat owner supplies its session's path resolver and sidebar opener. */
type LocalFiles = {
  resolve(value: string): string | undefined;
  source(path: string): string | undefined;
  open(path: string): void;
};
type Props = ComponentProps<typeof MarkdownText> & { localFiles?: LocalFiles; showFiles?: boolean };
type Reference = { known: boolean; embedded: boolean };
const EMPTY = new Map<string, boolean>();
const isImage = (path: string) => /\.(svg|png|jpe?g|gif|webp)$/i.test(path);

/** Keep the stock renderer for surfaces that have no session file owner. */
export function ArtifactMarkdown(props: Props) {
  return props.localFiles ? <FileMarkdown {...props} localFiles={props.localFiles} /> : <MarkdownText {...props} />;
}

function FileMarkdown({ localFiles, showFiles, ...props }: Props & { localFiles: LocalFiles }) {
  // References are collected by the Markdown AST renderer: fenced code, raw
  // HTML and ordinary prose never become filesystem requests.
  const references = useMemo(() => new Map<string, Reference>(), [localFiles, props.text]);
  const [checked, setChecked] = useState({ references, values: EMPTY });
  const values = checked.references === references ? checked.values : EMPTY;
  const mentions = useMemo(() => ({
    resolve(value: string, kind?: 'image') {
      const known = props.fileMentions?.resolve(value);
      const path = localFiles.resolve(known?.title ?? value);
      if (!path) return known;
      const previous = references.get(path);
      references.set(path, { known: !!known || previous?.known === true, embedded: kind === 'image' || previous?.embedded === true });
      if (known) return known;
      if (values.get(path) !== true) return undefined;
      return { open: () => localFiles.open(path), title: path, label: `打开 ${path}` };
    },
  }), [localFiles, props.fileMentions, references, values]);

  useEffect(() => {
    if (props.streaming) return;
    const pending = [...references].filter(([path]) => !values.has(path));
    if (!pending.length) return;
    const controller = new AbortController();
    const results = new Map<string, boolean>();
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length && !controller.signal.aborted) {
        const [path, reference] = pending[cursor++];
        let exists = reference.known;
        const source = localFiles.source(path);
        if (!exists && source) {
          try {
            const response = await fetch(source, { method: 'HEAD', signal: controller.signal });
            // A file exceeding the inline-media limit is still a file link.
            exists = response.ok || response.status === 413;
          } catch { exists = false; }
        }
        results.set(path, exists);
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker)).then(() => {
      if (!controller.signal.aborted) setChecked({ references, values: new Map([...values, ...results]) });
    });
    return () => controller.abort();
  }, [localFiles, references, mentions, values, props.streaming]);

  const images = showFiles && !props.streaming
    ? [...references].filter(([path, reference]) => values.get(path) === true && !reference.embedded && isImage(path))
    : [];
  return <>
    {images.length > 0 && <div className="desktop-artifact-previews" aria-label="生成文件预览">
      {images.map(([path]) => <button type="button" key={path} title={path} aria-label={`打开 ${path}`} onClick={() => localFiles.open(path)}>
        <img src={localFiles.source(path)} alt="" loading="lazy" decoding="async" onError={event => { event.currentTarget.hidden = true; }} />
        <span>{path.split(/[\\/]/).pop()}</span>
      </button>)}
    </div>}
    <MarkdownText {...props} fileMentions={mentions} />
  </>;
}
