export type JudgeScore = {
  score: number;
  max_score: number;
  reason: string;
};

export type JudgeRow = {
  name: string;
  score: number;
  max_score: number;
  threshold: number;
  passed: boolean;
};

export interface Judge {
  score(task: string, answer: string, rubric: string): Promise<JudgeScore>;
}

export class ScriptedJudge implements Judge {
  private scores: number[];
  max_score: number;

  constructor(scores: number[], max_score = 5) {
    this.scores = scores.slice();
    this.max_score = max_score;
  }

  async score(_task: string, _answer: string, _rubric: string): Promise<JudgeScore> {
    if (this.scores.length === 0) throw new Error("Judge 分数已用尽");
    return { score: this.scores.shift()!, max_score: this.max_score, reason: "scripted" };
  }
}
