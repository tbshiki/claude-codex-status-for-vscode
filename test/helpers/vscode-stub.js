'use strict';
// テスト用の 'vscode' モジュールの代役。out/ のコードを require する前に読み込むこと。
// 拡張機能ホストを起動せずに、表示文字列や取得のタイミングを Node だけで確かめるために使う。
const Module = require('node:module');

/** 設定値(claudeCodexStatus.* のキーから値)。テストごとに書き換える。 */
const config = {};
/** 作られたステータスバー項目(破棄済みも含む)。 */
const items = [];

class MarkdownString {
  constructor() {
    this.value = '';
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
  appendText(text) {
    this.value += text;
    return this;
  }
}

const vscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString,
  window: {
    createStatusBarItem(id, alignment, priority) {
      const item = {
        id,
        alignment,
        priority,
        text: '',
        tooltip: undefined,
        visible: false,
        disposed: false,
        show() {
          this.visible = true;
        },
        hide() {
          this.visible = false;
        },
        dispose() {
          this.disposed = true;
          this.visible = false;
        },
      };
      items.push(item);
      return item;
    },
    setStatusBarMessage() {},
    showWarningMessage() {},
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (key in config ? config[key] : fallback),
      update: async () => {},
    }),
  },
};

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
};

/** 設定と項目の記録を空にする。 */
function reset() {
  for (const key of Object.keys(config)) {
    delete config[key];
  }
  items.length = 0;
}

/** 破棄されていない項目を、id の末尾(claude / codex / paused)で引く。 */
function liveItem(name) {
  return items.find((i) => !i.disposed && i.id === `claudeCodexStatus.${name}`);
}

module.exports = { config, items, reset, liveItem };
