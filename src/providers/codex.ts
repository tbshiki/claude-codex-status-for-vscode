import { ProviderNotReadyError, ProviderUsage, UsageProvider } from './types';

/**
 * OpenAI Codex CLI の残量プロバイダ。
 *
 * 現状はスタブ。requirements.md の通り、取得方式(~/.codex/logs_*.sqlite の
 * 受動監視 or `codex app-server` への JSON-RPC 問い合わせ)が未確定のため、
 * 実装は次のマイルストーン(M2)で追加する。
 * それまでは ProviderNotReadyError を投げ、表示側で「準備中」と区別させる。
 */
export class CodexProvider implements UsageProvider {
  readonly id = 'codex' as const;
  readonly label = 'Codex';
  readonly icon = '$(zap)';

  fetchUsage(): Promise<ProviderUsage> {
    return Promise.reject(
      new ProviderNotReadyError('Codex 対応は準備中です(M2で実装予定)')
    );
  }
}
