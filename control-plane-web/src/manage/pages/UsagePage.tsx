import { PlannedPage } from '../components/bits';

export default function UsagePage() {
  return (
    <PlannedPage title="用量">
      增量 B 将按任务 · Worker · 引擎聚合真实用量（Token、耗时、费用），
      数据源为各 Worker journal 与观测 API。当前版本不展示估算或演示数字。
    </PlannedPage>
  );
}
