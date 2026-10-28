import type { ContentFindAction, ContentFindState } from '../../shared/content-find.ts';
import './style.css';

const api = window.dshContentFind;
const form = document.querySelector('form')!;
const input = document.querySelector('input')!;
const output = document.querySelector('output')!;
const error = document.querySelector<HTMLElement>('[role="alert"]')!;
const buttons = form.querySelectorAll('button');
let state: ContentFindState | undefined;
const send = (action: ContentFindAction) => { void api.act(action).catch(reason => { error.hidden = false; error.textContent = String(reason.message ?? reason); }); };
const move = (forward: boolean) => { if (state) send({ id: state.id, type: 'navigate', forward }); };
const render = (next: ContentFindState) => {
  if (state?.id !== next.id) input.value = next.query;
  state = next;
  if (next.query !== input.value) return;
  output.textContent = `${next.active}/${next.matches}${next.limited ? '+' : ''}`;
  buttons[0].disabled = buttons[1].disabled = !next.matches;
  error.textContent = next.error; error.title = next.error; error.hidden = !next.error;
};
api.onState(render);
api.onFocus(() => { input.focus(); input.select(); });
void api.state().then(value => { if (value) render(value); input.focus(); });
input.addEventListener('input', () => {
  if (!state) return;
  output.textContent = '0/0'; buttons[0].disabled = buttons[1].disabled = true;
  send({ id: state.id, type: 'query', query: input.value });
});
form.addEventListener('submit', event => { event.preventDefault(); move(true); });
input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); move(!event.shiftKey); } });
buttons[0].addEventListener('click', () => move(false));
buttons[1].addEventListener('click', () => move(true));
buttons[2].addEventListener('click', () => { if (state) send({ id: state.id, type: 'close' }); });
