import { useEffect, useState } from 'react';
import type { BrowserContext } from './sidebar-browser.tsx';
import type { PluginSecurityReport } from '../shared/plugin-security.ts';
import './plugin-security.css';

interface ReviewProps {
  phase: 'reviewing' | 'preparing' | 'review';
  direct: boolean;
  spec: string;
  report: PluginSecurityReport | null;
  error: string | null;
  acknowledged: boolean;
  onAcknowledge(value: boolean): void;
  onContinue(): void;
  onRetry(): void;
  onSkip(): void;
  onCancel(): void;
}
const riskLabels = { low: '较低风险', medium: '中等风险', high: '较高风险', unknown: '风险未知', critical: '严重风险' };

function PluginSecurityReview({ phase, direct, spec, report, error, acknowledged, onAcknowledge, onContinue, onRetry, onSkip, onCancel }: ReviewProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [report]);
  const age = report ? now - Date.parse(report.checkedAt) : NaN;
  const expired = report !== null && (!Number.isFinite(age) || age < 0 || age >= 10 * 60 * 1000);
  const failure = error || report?.error?.message || (report && (!report.reviewId || !report.sha256) ? '缺少已检查安装包的确认标识，请重新检查。' : undefined);
  const canContinue = phase === 'review' && report !== null && !failure && !expired && report.spec === spec;
  return <section className="desktop-plugin-security" data-plugin-security-review data-install-phase={phase} aria-busy={phase !== 'review'}>
    <p className="desktop-plugin-security-spec">{spec}</p>
    {phase !== 'review' ? <p role="status">{phase === 'preparing' ? direct ? '正在下载安装包…' : '正在确认安装包与检查报告一致…' : 'DSH 正在检查插件材料，请稍候。此过程不会安装或执行插件。'}</p> : <>
      {failure && <p className="desktop-plugin-security-error" role="alert">{failure}</p>}
      {report && <>
        <div className="desktop-plugin-security-summary"><strong data-plugin-security-risk={report.risk}>{riskLabels[report.risk]}</strong><span>{report.status === 'complete' ? '检查报告' : '检查不完整'}</span></div>
        <p>{report.summary}</p>
        <p className="desktop-plugin-security-meta">检查时间：{new Date(report.checkedAt).toLocaleString('zh-CN')}{report.reviewer ? ` · ${report.reviewer.provider} / ${report.reviewer.model}` : ''}</p>
        {report.findings.length > 0 ? <ol className="desktop-plugin-security-findings">{report.findings.map((finding, index) => <li key={index}>
          <h3><span>{riskLabels[finding.severity]}</span> {finding.title}</h3>
          <p className="desktop-plugin-security-path">{finding.evidence.path}</p><pre>{finding.evidence.quote}</pre><p>{finding.recommendation}</p>
        </li>)}</ol> : !failure && <p>本次提供的材料中没有列出具体风险发现；这不构成安全保证。</p>}
        {report.scope && <p className="desktop-plugin-security-meta">检查了 {report.scope.filesReviewed} / {report.scope.filesTotal} 个文件，{report.scope.bytesReviewed.toLocaleString('zh-CN')} 字节；依赖仅检查声明。{report.scope.truncated ? ' 部分内容已截断。' : ''}</p>}
        {report.limitations.length > 0 && <div><h3>检查范围与限制</h3><ul>{report.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></div>}
        {report.sha256 && <details><summary>本次材料标识</summary><p className="desktop-plugin-security-hash">SHA-256：<code data-plugin-security-sha256>{report.sha256}</code></p>{report.integrity && <p className="desktop-plugin-security-hash">包完整性：{report.integrity}</p>}<p>安装将使用本次检查的同一份包。</p></details>}
        {expired && <p className="desktop-plugin-security-error" role="alert">报告已超过 10 分钟有效期，请重新检查。</p>}
      </>}
      {canContinue && <label className="desktop-plugin-security-consent"><input type="checkbox" aria-label="我已阅读报告并接受相关风险" checked={acknowledged} onChange={event => onAcknowledge(event.currentTarget.checked)} /><span>我已阅读报告并接受相关风险</span></label>}
    </>}
    <div className="desktop-plugin-security-actions"><button onClick={onCancel}>取消安装</button>{phase === 'review' && <button onClick={onRetry}>重新检查</button>}{phase !== 'preparing' && <button data-plugin-security-skip onClick={onSkip}>直接安装</button>}{canContinue && <button data-plugin-security-continue disabled={!acknowledged} onClick={onContinue}>继续安装</button>}</div>
  </section>;
}

export function installPluginSecurityReview(ctx: Pick<BrowserContext, 'slots'>): void {
  ctx.slots.inject('plugins.install.review', () => ctx.slots.register({ name: 'plugins.install.review' }, PluginSecurityReview));
}
