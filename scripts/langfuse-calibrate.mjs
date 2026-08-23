#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { judgeConversation, RUBRIC_VERSION } from './langfuse-judge.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const fixturePath =
  process.argv[2] || path.join(ROOT, 'tests', 'evaluation', 'judge-calibration.json');
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const results = [];

for (const testCase of cases) {
  const judged = await judgeConversation(testCase.material);
  const predicted = judged.evaluation.overall_score;
  const expected = Number(testCase.human.overall_score);
  const predictedPass =
    predicted >= Number(process.env.LANGFUSE_LLM_JUDGE_MIN_SCORE || 0.75) &&
    judged.evaluation.critical_failures.length === 0;
  const expectedPass = testCase.human.verdict === 'pass';
  const result = {
    id: testCase.id,
    expected_score: expected,
    predicted_score: predicted,
    absolute_error: Math.abs(predicted - expected),
    expected_verdict: testCase.human.verdict,
    predicted_verdict: judged.evaluation.verdict,
    pass_agreement: predictedPass === expectedPass,
    summary: judged.evaluation.summary,
    usage: judged.usage,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}

const mae = results.reduce((sum, result) => sum + result.absolute_error, 0) / results.length;
const agreement =
  results.filter((result) => result.pass_agreement).length / Math.max(1, results.length);
const report = {
  rubric_version: RUBRIC_VERSION,
  case_count: results.length,
  mean_absolute_error: Number(mae.toFixed(4)),
  pass_fail_agreement: Number(agreement.toFixed(4)),
  thresholds: { max_mae: 0.2, min_agreement: 0.8 },
  passed: mae <= 0.2 && agreement >= 0.8,
};
console.log(JSON.stringify({ calibration: report }));
process.exitCode = report.passed ? 0 : 1;
