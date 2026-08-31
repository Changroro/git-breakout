import type { RepositoryCandidate } from "../lib/ranking.ts";

export const SAMPLE_CAPTURED_AT = "2026-08-25T00:00:00.000Z";

type SampleSeed = {
  fullName: string;
  description: string;
  language: string;
  stars: number;
  forks: number;
  issues: number;
  createdDaysAgo: number;
  pushedHoursAgo: number;
  delta1h: number | null;
  delta6h: number | null;
  delta24h: number | null;
  observedStarsPerDay: number | null;
  dailyRank: number | null;
  weeklyRank: number | null;
  monthlyRank: number | null;
  firstObservation: boolean;
};

const seeds: SampleSeed[] = [
  { fullName: "openai/codex", description: "터미널에서 동작하는 코딩 에이전트", language: "Rust", stars: 48210, forks: 5280, issues: 312, createdDaysAgo: 410, pushedHoursAgo: 2, delta1h: 184, delta6h: 812, delta24h: 2240, observedStarsPerDay: 2240, dailyRank: 1, weeklyRank: 3, monthlyRank: 8, firstObservation: false },
  { fullName: "anthropics/claude-code", description: "코드베이스를 이해하고 작업하는 에이전트 도구", language: "TypeScript", stars: 39140, forks: 3140, issues: 184, createdDaysAgo: 368, pushedHoursAgo: 3, delta1h: 138, delta6h: 691, delta24h: 1870, observedStarsPerDay: 1870, dailyRank: 2, weeklyRank: 1, monthlyRank: 4, firstObservation: false },
  { fullName: "langchain-ai/deepagents", description: "장기 작업을 위한 에이전트 실행 프레임워크", language: "Python", stars: 13780, forks: 1180, issues: 96, createdDaysAgo: 146, pushedHoursAgo: 1, delta1h: 126, delta6h: 574, delta24h: 1412, observedStarsPerDay: 1412, dailyRank: 4, weeklyRank: 6, monthlyRank: null, firstObservation: false },
  { fullName: "browser-use/browser-use", description: "AI 에이전트를 위한 브라우저 자동화 라이브러리", language: "Python", stars: 71420, forks: 8230, issues: 428, createdDaysAgo: 612, pushedHoursAgo: 5, delta1h: 81, delta6h: 452, delta24h: 1196, observedStarsPerDay: 1196, dailyRank: 6, weeklyRank: 4, monthlyRank: 2, firstObservation: false },
  { fullName: "modelcontextprotocol/servers", description: "Model Context Protocol 공식 서버 모음", language: "TypeScript", stars: 68430, forks: 7610, issues: 244, createdDaysAgo: 630, pushedHoursAgo: 4, delta1h: 75, delta6h: 389, delta24h: 1034, observedStarsPerDay: 1034, dailyRank: 3, weeklyRank: 2, monthlyRank: 1, firstObservation: false },
  { fullName: "microsoft/markitdown", description: "문서를 Markdown으로 변환하는 경량 도구", language: "Python", stars: 84620, forks: 4520, issues: 173, createdDaysAgo: 780, pushedHoursAgo: 18, delta1h: 56, delta6h: 301, delta24h: 924, observedStarsPerDay: 924, dailyRank: 8, weeklyRank: 9, monthlyRank: 7, firstObservation: false },
  { fullName: "ollama/ollama", description: "로컬에서 대형 언어 모델을 실행하는 런타임", language: "Go", stars: 152340, forks: 12980, issues: 1312, createdDaysAgo: 1220, pushedHoursAgo: 1, delta1h: 44, delta6h: 287, delta24h: 816, observedStarsPerDay: 816, dailyRank: 9, weeklyRank: 7, monthlyRank: 3, firstObservation: false },
  { fullName: "open-webui/open-webui", description: "로컬 AI 모델을 위한 확장 가능한 웹 인터페이스", language: "Svelte", stars: 108730, forks: 14620, issues: 508, createdDaysAgo: 970, pushedHoursAgo: 2, delta1h: 48, delta6h: 276, delta24h: 782, observedStarsPerDay: 782, dailyRank: 7, weeklyRank: 5, monthlyRank: 5, firstObservation: false },
  { fullName: "continuedev/continue", description: "IDE에서 사용하는 오픈소스 코딩 에이전트", language: "TypeScript", stars: 32760, forks: 3920, issues: 652, createdDaysAgo: 1050, pushedHoursAgo: 6, delta1h: 39, delta6h: 219, delta24h: 641, observedStarsPerDay: 641, dailyRank: 11, weeklyRank: 8, monthlyRank: 10, firstObservation: false },
  { fullName: "cline/cline", description: "에디터 안에서 계획하고 실행하는 자율 코딩 에이전트", language: "TypeScript", stars: 58310, forks: 6140, issues: 903, createdDaysAgo: 720, pushedHoursAgo: 1, delta1h: 34, delta6h: 198, delta24h: 594, observedStarsPerDay: 594, dailyRank: 10, weeklyRank: 11, monthlyRank: 6, firstObservation: false },
  { fullName: "langgenius/dify", description: "생성형 AI 애플리케이션 개발 플랫폼", language: "TypeScript", stars: 126840, forks: 19240, issues: 614, createdDaysAgo: 1340, pushedHoursAgo: 3, delta1h: 31, delta6h: 181, delta24h: 548, observedStarsPerDay: 548, dailyRank: 13, weeklyRank: 10, monthlyRank: 9, firstObservation: false },
  { fullName: "n8n-io/n8n", description: "AI 기능을 포함한 워크플로 자동화 플랫폼", language: "TypeScript", stars: 138920, forks: 42130, issues: 712, createdDaysAgo: 2480, pushedHoursAgo: 2, delta1h: 28, delta6h: 166, delta24h: 507, observedStarsPerDay: 507, dailyRank: 12, weeklyRank: 12, monthlyRank: 12, firstObservation: false },
  { fullName: "crewAIInc/crewAI", description: "역할 기반 멀티 에이전트 오케스트레이션 프레임워크", language: "Python", stars: 41870, forks: 5590, issues: 214, createdDaysAgo: 790, pushedHoursAgo: 9, delta1h: 24, delta6h: 141, delta24h: 432, observedStarsPerDay: 432, dailyRank: 14, weeklyRank: 14, monthlyRank: 11, firstObservation: false },
  { fullName: "FoundationAgents/OpenManus", description: "범용 에이전트를 위한 개방형 구현", language: "Python", stars: 36210, forks: 5210, issues: 327, createdDaysAgo: 520, pushedHoursAgo: 7, delta1h: 22, delta6h: 128, delta24h: 394, observedStarsPerDay: 394, dailyRank: 15, weeklyRank: 13, monthlyRank: 14, firstObservation: false },
  { fullName: "mem0ai/mem0", description: "AI 애플리케이션을 위한 장기 메모리 계층", language: "Python", stars: 51430, forks: 4760, issues: 236, createdDaysAgo: 810, pushedHoursAgo: 4, delta1h: 18, delta6h: 112, delta24h: 351, observedStarsPerDay: 351, dailyRank: 17, weeklyRank: 15, monthlyRank: 13, firstObservation: false },
  { fullName: "comfyanonymous/ComfyUI", description: "노드 기반 생성 이미지 워크플로 도구", language: "Python", stars: 93640, forks: 10120, issues: 2370, createdDaysAgo: 1410, pushedHoursAgo: 1, delta1h: 16, delta6h: 102, delta24h: 326, observedStarsPerDay: 326, dailyRank: 16, weeklyRank: 16, monthlyRank: 15, firstObservation: false },
  { fullName: "huggingface/transformers", description: "최신 머신러닝 모델을 제공하는 핵심 라이브러리", language: "Python", stars: 145620, forks: 29510, issues: 1420, createdDaysAgo: 2790, pushedHoursAgo: 2, delta1h: 14, delta6h: 96, delta24h: 302, observedStarsPerDay: 302, dailyRank: 18, weeklyRank: 18, monthlyRank: 16, firstObservation: false },
  { fullName: "vllm-project/vllm", description: "빠른 LLM 추론과 서빙을 위한 엔진", language: "Python", stars: 62830, forks: 10420, issues: 1760, createdDaysAgo: 1150, pushedHoursAgo: 1, delta1h: 15, delta6h: 91, delta24h: 288, observedStarsPerDay: 288, dailyRank: 19, weeklyRank: 17, monthlyRank: 17, firstObservation: false },
  { fullName: "ggerganov/llama.cpp", description: "다양한 환경에서 LLM을 실행하는 C++ 런타임", language: "C++", stars: 96210, forks: 15380, issues: 1080, createdDaysAgo: 1320, pushedHoursAgo: 2, delta1h: 13, delta6h: 84, delta24h: 264, observedStarsPerDay: 264, dailyRank: 20, weeklyRank: 19, monthlyRank: 18, firstObservation: false },
  { fullName: "microsoft/autogen", description: "대화형 멀티 에이전트 애플리케이션 프레임워크", language: "Python", stars: 49670, forks: 7420, issues: 387, createdDaysAgo: 1180, pushedHoursAgo: 8, delta1h: 11, delta6h: 73, delta24h: 238, observedStarsPerDay: 238, dailyRank: null, weeklyRank: 20, monthlyRank: 19, firstObservation: false },
  { fullName: "run-llama/llama_index", description: "LLM 애플리케이션을 위한 데이터 연결 프레임워크", language: "Python", stars: 42120, forks: 5930, issues: 602, createdDaysAgo: 1450, pushedHoursAgo: 3, delta1h: 10, delta6h: 67, delta24h: 216, observedStarsPerDay: 216, dailyRank: null, weeklyRank: null, monthlyRank: 20, firstObservation: false },
  { fullName: "BerriAI/litellm", description: "여러 LLM 공급자를 하나의 API로 연결하는 프록시", language: "Python", stars: 28460, forks: 3860, issues: 712, createdDaysAgo: 970, pushedHoursAgo: 1, delta1h: 9, delta6h: 61, delta24h: 198, observedStarsPerDay: 198, dailyRank: null, weeklyRank: null, monthlyRank: null, firstObservation: false },
  { fullName: "openai/openai-agents-python", description: "멀티 에이전트 워크플로를 위한 Python SDK", language: "Python", stars: 22180, forks: 2710, issues: 156, createdDaysAgo: 440, pushedHoursAgo: 4, delta1h: 8, delta6h: 54, delta24h: 176, observedStarsPerDay: 176, dailyRank: null, weeklyRank: null, monthlyRank: null, firstObservation: false },
  { fullName: "infiniflow/ragflow", description: "문서 이해에 초점을 둔 RAG 엔진", language: "Python", stars: 68820, forks: 7460, issues: 894, createdDaysAgo: 930, pushedHoursAgo: 5, delta1h: 7, delta6h: 49, delta24h: 161, observedStarsPerDay: 161, dailyRank: null, weeklyRank: null, monthlyRank: null, firstObservation: false },
  { fullName: "mindsdb/mindsdb", description: "AI 쿼리와 자동화를 위한 데이터 플랫폼", language: "Python", stars: 31870, forks: 5270, issues: 412, createdDaysAgo: 2090, pushedHoursAgo: 6, delta1h: 6, delta6h: 43, delta24h: 147, observedStarsPerDay: 147, dailyRank: null, weeklyRank: null, monthlyRank: null, firstObservation: false },
  { fullName: "aider-ai/aider", description: "터미널에서 사용하는 AI 페어 프로그래밍 도구", language: "Python", stars: 39730, forks: 3720, issues: 391, createdDaysAgo: 1080, pushedHoursAgo: 2, delta1h: 6, delta6h: 39, delta24h: 136, observedStarsPerDay: 136, dailyRank: null, weeklyRank: null, monthlyRank: null, firstObservation: false },
  { fullName: "abi/screenshot-to-code", description: "스크린샷을 프론트엔드 코드로 변환하는 도구", language: "TypeScript", stars: 74210, forks: 9180, issues: 205, createdDaysAgo: 1010, pushedHoursAgo: 32, delta1h: 4, delta6h: 31, delta24h: 112, observedStarsPerDay: 112, dailyRank: null, weeklyRank: null, monthlyRank: null, firstObservation: false },
  { fullName: "neuml/txtai", description: "시맨틱 검색과 LLM 워크플로를 위한 데이터베이스", language: "Python", stars: 12860, forks: 920, issues: 58, createdDaysAgo: 1880, pushedHoursAgo: 22, delta1h: 3, delta6h: 24, delta24h: 89, observedStarsPerDay: 89, dailyRank: null, weeklyRank: null, monthlyRank: null, firstObservation: false },
  { fullName: "sample-labs/context-graph", description: "에이전트 컨텍스트를 그래프로 추적하는 실험 프로젝트", language: "Rust", stars: 1840, forks: 112, issues: 17, createdDaysAgo: 46, pushedHoursAgo: 3, delta1h: null, delta6h: null, delta24h: null, observedStarsPerDay: null, dailyRank: 22, weeklyRank: null, monthlyRank: null, firstObservation: true },
  { fullName: "sample-labs/tool-router", description: "에이전트 도구 호출을 정책에 따라 라우팅하는 런타임", language: "Go", stars: 1260, forks: 84, issues: 9, createdDaysAgo: 31, pushedHoursAgo: 2, delta1h: null, delta6h: null, delta24h: null, observedStarsPerDay: null, dailyRank: 24, weeklyRank: null, monthlyRank: null, firstObservation: true }
];

function subtractTime(days: number, hours: number): string {
  const timestamp = Date.parse(SAMPLE_CAPTURED_AT) - days * 86_400_000 - hours * 3_600_000;
  return new Date(timestamp).toISOString();
}

export const sampleRepositories: RepositoryCandidate[] = seeds.map((seed) => ({
  full_name: seed.fullName,
  url: `https://github.com/${seed.fullName}`,
  open_graph_image_url: `https://opengraph.githubassets.com/ai-trend-radar/${seed.fullName}`,
  description: seed.description,
  language: seed.language,
  topics: ["ai", seed.language.toLowerCase()],
  observation_sources: [
    ...(seed.dailyRank === null ? [] : ["official_daily" as const]),
    ...(seed.weeklyRank === null ? [] : ["official_weekly" as const]),
    ...(seed.monthlyRank === null ? [] : ["official_monthly" as const]),
    ...(seed.dailyRank === null && seed.weeklyRank === null && seed.monthlyRank === null
      ? ["github_search_pushed" as const]
      : []),
  ],
  created_at: subtractTime(seed.createdDaysAgo, 0),
  pushed_at: subtractTime(0, seed.pushedHoursAgo),
  metrics: {
    stars: seed.stars,
    forks: seed.forks,
    watchers: seed.stars,
    open_issues: seed.issues,
  },
  official_ranks: {
    daily: seed.dailyRank,
    weekly: seed.weeklyRank,
    monthly: seed.monthlyRank,
  },
  growth: {
    stars_delta_1h: seed.delta1h,
    stars_delta_6h: seed.delta6h,
    stars_delta_24h: seed.delta24h,
  },
  observedStarsPerDay: seed.observedStarsPerDay,
  firstObservation: seed.firstObservation,
}));

export type SampleSnapshot = {
  id: string;
  capturedAt: string;
  source: "sample";
  repositories: RepositoryCandidate[];
};

const SAMPLE_HISTORY_DATES = [
  "2026-08-22T00:00:00.000Z",
  "2026-08-23T00:00:00.000Z",
  "2026-08-24T00:00:00.000Z",
  SAMPLE_CAPTURED_AT,
] as const;

function historicalRepositories(capturedAt: string, snapshotIndex: number): RepositoryCandidate[] {
  const daysBeforeLatest = SAMPLE_HISTORY_DATES.length - snapshotIndex - 1;
  const capturedTimestamp = Date.parse(capturedAt);
  const latestTimestamp = Date.parse(SAMPLE_CAPTURED_AT);

  return sampleRepositories.flatMap((repository, repositoryIndex) => {
    if (repository.firstObservation && daysBeforeLatest > 0) {
      return [];
    }

    const activityFactor =
      daysBeforeLatest === 0
        ? 1
        : 0.58 + ((repositoryIndex * 5 + snapshotIndex * 3) % 10) * 0.09;
    const stars = repository.metrics.stars;
    const forks = repository.metrics.forks;
    const dailyGrowth = repository.growth.stars_delta_24h;
    const pushAge = repository.pushed_at === null ? null : latestTimestamp - Date.parse(repository.pushed_at);
    const scaledGrowth = (value: number | null) =>
      value === null ? null : Math.max(0, Math.round(value * activityFactor));

    return [{
      ...repository,
      topics: [...repository.topics],
      observation_sources: [...repository.observation_sources],
      pushed_at: pushAge === null ? null : new Date(capturedTimestamp - pushAge).toISOString(),
      metrics: {
        ...repository.metrics,
        stars:
          stars === null || dailyGrowth === null
            ? stars
            : Math.max(0, stars - dailyGrowth * daysBeforeLatest),
        forks:
          forks === null || dailyGrowth === null
            ? forks
            : Math.max(0, forks - Math.round(dailyGrowth * daysBeforeLatest * 0.06)),
        watchers:
          stars === null || dailyGrowth === null
            ? repository.metrics.watchers
            : Math.max(0, stars - dailyGrowth * daysBeforeLatest),
      },
      official_ranks: { ...repository.official_ranks },
      growth: {
        stars_delta_1h: scaledGrowth(repository.growth.stars_delta_1h),
        stars_delta_6h: scaledGrowth(repository.growth.stars_delta_6h),
        stars_delta_24h: scaledGrowth(repository.growth.stars_delta_24h),
      },
      observedStarsPerDay:
        repository.observedStarsPerDay === null
          ? null
          : Math.max(0, Math.round(repository.observedStarsPerDay * activityFactor)),
    }];
  });
}

export const sampleSnapshots: SampleSnapshot[] = SAMPLE_HISTORY_DATES.map(
  (capturedAt, snapshotIndex) => ({
    id: `sample-${capturedAt.slice(0, 10)}`,
    capturedAt,
    source: "sample",
    repositories: historicalRepositories(capturedAt, snapshotIndex),
  }),
);
