import { mountGitView } from '../../src/gitView/main';

const host = document.getElementById('app') as HTMLElement;
const view = mountGitView(host, '../../dist/gitView.css', () => {}, () => {});
window.addEventListener('message', event => view.handleMessage(event.data));
