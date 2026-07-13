import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  NotAuthenticatedError,
  ProviderUsage,
  UsageProvider,
  WindowUsage,
} from './types';

/** api.anthropic.com が返す生レスポンス(非公式・非保証)。 */
interface RawWindowUsage {
  utilization: number;
  resets_at: string | null;
}

interface RawUsageResponse {
  five_hour: RawWindowUsage;
  seven_day: RawWindowUsage;
}

/**
 * Claude Code の OAuth 認証情報を使い、5時間枠/週枠の利用率を取得する。
 * エンドポイントとヘッダは非公式のため、失敗時は例外に委ねてフェイルソフトにする。
 */
export class ClaudeProvider implements UsageProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude';
  readonly icon = '$(pulse)';

  async fetchUsage(): Promise<ProviderUsage> {
    const token = this.readAccessToken();
    if (!token) {
      throw new NotAuthenticatedError(
        'credentials.json からトークンを取得できませんでした。claude login を確認してください。'
      );
    }
    const raw = await this.request(token);
    return {
      fiveHour: normalizeWindow(raw.five_hour),
      sevenDay: normalizeWindow(raw.seven_day),
    };
  }

  private getCredentialsPath(): string {
    const cfg = vscode.workspace.getConfiguration('claudeCodexStatus');
    const override = cfg.get<string>('claude.credentialsPath', '');
    if (override && override.trim().length > 0) {
      return override;
    }
    return path.join(os.homedir(), '.claude', '.credentials.json');
  }

  private readAccessToken(): string | undefined {
    const credPath = this.getCredentialsPath();
    try {
      const rawText = fs.readFileSync(credPath, 'utf8');
      const json = JSON.parse(rawText);
      return json?.claudeAiOauth?.accessToken;
    } catch {
      return undefined;
    }
  }

  private request(token: string): Promise<RawUsageResponse> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.anthropic.com',
          path: '/api/oauth/usage',
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
          },
          timeout: 10000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              try {
                resolve(JSON.parse(data) as RawUsageResponse);
              } catch {
                reject(new Error('レスポンスのJSON解析に失敗しました'));
              }
            } else {
              reject(new Error(`HTTP ${status}`));
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }
}

function normalizeWindow(raw: RawWindowUsage | undefined): WindowUsage {
  return {
    utilization: Math.round(raw?.utilization ?? 0),
    resetsAt: raw?.resets_at ?? null,
  };
}
