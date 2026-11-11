import { describe, expect, it } from 'vitest';
import {
  autoTitle,
  checkBodyWithinLimits,
  codePoints,
  describeInputProblem,
  lineCount,
  normalizeBody,
  resolveTextInputLimits,
  utf8Bytes
} from '../../src/renderer/app/inputPolicy';

/**
 * 长输入设计 §5.1/§5.3/§7 的渲染器侧输入政策：与后端 InputPolicy 同规则。
 * code points 按 Unicode 计数（不是 JS length）；R0 回退 4000/200；错误只解释不编造草稿承诺。
 */
describe('renderer input policy (long input §5)', () => {
  it('counts code points like the service (emoji is one point, not two units)', () => {
    expect(codePoints('😀')).toBe(1);
    expect(codePoints('a😀b')).toBe(3);
    expect(codePoints('')).toBe(0);
    expect('😀'.length).toBe(2);
  });

  it('counts UTF-8 bytes with an explicit encoder', () => {
    expect(utf8Bytes('你好吗')).toBe(9);
    expect(utf8Bytes('😀')).toBe(4);
  });

  it('normalizes only BOM + CRLF, keeping surrounding spaces', () => {
    expect(normalizeBody('﻿ hi ')).toBe(' hi ');
    expect(normalizeBody('a\r\nb')).toBe('a\nb');
    expect(normalizeBody('a\rb')).toBe('a\nb');
  });

  it('derives an 80-point auto title without truncating the body', () => {
    expect(autoTitle('  a\nb\tc  ')).toBe('a b c');
    expect(autoTitle('   ')).toBeNull();
    const title = autoTitle('x'.repeat(500));
    expect(title !== null && codePoints(title)).toBe(80);
    const emojiTitle = autoTitle('😀'.repeat(500));
    expect(emojiTitle !== null && codePoints(emojiTitle)).toBe(80);
    expect(emojiTitle !== null && emojiTitle.length <= 200).toBe(true);
  });

  it('counts lines on normalized LF (empty is zero)', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('one')).toBe(1);
    expect(lineCount('a\nb')).toBe(2);
  });

  it('falls back to legacy 4000/200 without R1 capability (never assumes unlimited)', () => {
    const limits = resolveTextInputLimits(null);
    expect(limits.r1Available).toBe(false);
    expect(limits.messageMax).toBe(4000);
    expect(limits.messageMaxUnit).toBe('characters');
    const ok = checkBodyWithinLimits('a'.repeat(4000), limits);
    expect(ok.ok).toBe(true);
    const over = checkBodyWithinLimits('a'.repeat(4001), limits);
    expect(over.ok).toBe(false);
    expect(over.message).toContain('草稿已保留');
  });

  it('enables R1 code-point rules only when capability publishes input-policy/1 + 32000', () => {
    const limits = resolveTextInputLimits({
      inputPolicyVersion: 'input-policy/1',
      messageMaxCodePoints: 32000
    });
    expect(limits.r1Available).toBe(true);
    expect(checkBodyWithinLimits('😀'.repeat(32000), limits).ok).toBe(true);
    expect(checkBodyWithinLimits('😀'.repeat(32001), limits).ok).toBe(false);
  });

  it('explains structured input problems without claiming draft retention for the service', () => {
    expect(describeInputProblem(new Error('INPUT_LIMIT_EXCEEDED: content exceeds 4000 characters')))
      .toContain('草稿已保留');
    expect(describeInputProblem(new Error('ATTACHMENT_INVALID_ENCODING')))
      .toContain('UTF-8');
    expect(describeInputProblem(new Error('ATTACHMENT_CHANNEL_UNAVAILABLE')))
      .toContain('不会静默丢弃');
    expect(describeInputProblem(new Error('IDEMPOTENCY_PAYLOAD_MISMATCH')))
      .toContain('拒绝覆盖');
    expect(describeInputProblem(new Error('SCHEDULING_OUTCOME_UNKNOWN')))
      .toContain('结果未知');
    expect(describeInputProblem(new Error('something else entirely'))).toBeNull();
  });
});
