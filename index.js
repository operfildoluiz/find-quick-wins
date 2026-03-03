#!/usr/bin/env node

/**
 * FindQuickWins — CLI tool that analyzes a GitHub repository and identifies
 * quick-win contribution opportunities using the DeepSeek API.
 *
 * Usage: npx find-quick-wins <github-url>
 * Example: npx find-quick-wins https://github.com/expressjs/express
 */

import "dotenv/config";
import axios from "axios";
import chalk from "chalk";
import ora from "ora";
import fs from "fs";
import path from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";
const DEEPSEEK_API = "https://api.deepseek.com/v1/chat/completions";
const MAX_ISSUES_TO_FETCH = 50; // Cap to keep the prompt size reasonable
const MAX_ISSUE_BODY_LENGTH = 300; // Truncate long issue bodies for the prompt
const MAX_README_LENGTH = 2000; // Truncate readme for the prompt

// ─── GitHub URL Parser ────────────────────────────────────────────────────────

/**
 * Extracts the owner and repo name from a variety of GitHub URL formats.
 * Supports: https://github.com/owner/repo, github.com/owner/repo, owner/repo
 *
 * @param {string} input - Raw URL or shorthand provided by the user
 * @returns {{ owner: string, repo: string }}
 */
function parseGitHubUrl(input) {
  if (!input) {
    throw new Error("No GitHub URL provided. Usage: node index.js <github-url>");
  }

  // Normalize: strip trailing slashes, .git suffix, and URL fragments/query strings
  const cleaned = input
    .trim()
    .replace(/\.git$/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");

  // Match full URL: https://github.com/owner/repo or http://github.com/owner/repo
  const fullUrlMatch = cleaned.match(/^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)/i);
  if (fullUrlMatch) {
    return { owner: fullUrlMatch[1], repo: fullUrlMatch[2] };
  }

  // Match shorthand: owner/repo
  const shorthandMatch = cleaned.match(/^([^/]+)\/([^/]+)$/);
  if (shorthandMatch) {
    return { owner: shorthandMatch[1], repo: shorthandMatch[2] };
  }

  throw new Error(`Could not parse GitHub URL: "${input}"\n` + "Expected formats: https://github.com/owner/repo  OR  owner/repo");
}

// ─── GitHub API Client ────────────────────────────────────────────────────────

/**
 * Creates an axios instance pre-configured for the GitHub REST API.
 * Attaches a Bearer token if GITHUB_TOKEN is present in the environment,
 * which raises the rate limit from 60 to 5,000 requests per hour.
 */
function createGitHubClient() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return axios.create({ baseURL: GITHUB_API, headers });
}

/**
 * Fetches core repository metadata (name, description, stars, language, etc.)
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} owner
 * @param {string} repo
 */
async function fetchRepoInfo(client, owner, repo) {
  try {
    const { data } = await client.get(`/repos/${owner}/${repo}`);
    return {
      fullName: data.full_name,
      description: data.description || "(no description)",
      stars: data.stargazers_count,
      forks: data.forks_count,
      language: data.language || "Unknown",
      openIssuesCount: data.open_issues_count,
      hasWiki: data.has_wiki,
      license: data.license?.name || "None",
      topics: data.topics || [],
      htmlUrl: data.html_url,
      defaultBranch: data.default_branch,
      createdAt: data.created_at?.split("T")[0],
      updatedAt: data.updated_at?.split("T")[0],
    };
  } catch (err) {
    handleGitHubError(err, owner, repo);
  }
}

/**
 * Fetches open issues (excludes pull requests) up to MAX_ISSUES_TO_FETCH.
 * Returns a lean summary of each issue suitable for inclusion in an LLM prompt.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} owner
 * @param {string} repo
 */
async function fetchOpenIssues(client, owner, repo) {
  try {
    const { data } = await client.get(`/repos/${owner}/${repo}/issues`, {
      params: {
        state: "open",
        per_page: MAX_ISSUES_TO_FETCH,
        sort: "updated",
        direction: "desc",
      },
    });

    // GitHub's /issues endpoint includes PRs — filter them out
    const issues = data.filter((item) => !item.pull_request);

    return issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: (issue.body || "").substring(0, MAX_ISSUE_BODY_LENGTH),
      labels: issue.labels.map((l) => l.name),
      comments: issue.comments,
      createdAt: issue.created_at?.split("T")[0],
      url: issue.html_url,
    }));
  } catch (err) {
    // Non-fatal: we can still analyse the repo even without issues
    console.warn(chalk.yellow("  ⚠ Could not fetch issues:", err.message));
    return [];
  }
}

/**
 * Fetches the repository's language breakdown (e.g. { JavaScript: 45321, CSS: 3200 }).
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} owner
 * @param {string} repo
 */
async function fetchLanguages(client, owner, repo) {
  try {
    const { data } = await client.get(`/repos/${owner}/${repo}/languages`);
    // Calculate percentages for the top 5 languages
    const total = Object.values(data).reduce((sum, v) => sum + v, 0);
    return Object.entries(data)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([lang, bytes]) => ({
        language: lang,
        percentage: ((bytes / total) * 100).toFixed(1) + "%",
      }));
  } catch {
    return [];
  }
}

/**
 * Fetches and base64-decodes the README so the LLM can assess documentation quality.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} owner
 * @param {string} repo
 */
async function fetchReadme(client, owner, repo) {
  try {
    const { data } = await client.get(`/repos/${owner}/${repo}/readme`);
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return content.substring(0, MAX_README_LENGTH);
  } catch {
    return null; // README may not exist
  }
}

// ─── DeepSeek Integration ─────────────────────────────────────────────────────

/**
 * Builds a structured prompt for DeepSeek that describes the repo and its issues,
 * then asks the model to identify quick-win contributions.
 *
 * @param {object} repoInfo
 * @param {object[]} issues
 * @param {object[]} languages
 * @param {string|null} readme
 */
function buildAnalysisPrompt(repoInfo, issues, languages, readme) {
  const issuesSummary =
    issues.length > 0
      ? issues
          .map((i) => `  #${i.number} [${i.labels.join(", ") || "no labels"}] ${i.title}\n` + (i.body ? `    Body: ${i.body.replace(/\n/g, " ")}\n` : ""))
          .join("\n")
      : "  (No open issues found)";

  const languageSummary = languages.map((l) => `${l.language} (${l.percentage})`).join(", ") || repoInfo.language;

  const readmeSection = readme ? `README preview (first ${MAX_README_LENGTH} chars):\n${readme}` : "README: Not found or empty.";

  return `You are an expert open-source contribution advisor. Analyze the following GitHub repository and identify the best "quick win" contribution opportunities — tasks that:
- Do NOT require deep domain knowledge of the codebase
- Have clear, well-defined scope and low risk of breaking things
- Can be completed quickly by a new contributor
- If the author hasn't explicitly mentioned, a quick win also can be something primarily tackled with AI assistance (e.g. write unit tests for a pure function, generating annotations and documentation, scanning for and fixing typos, linting/formatting fixes, etc.)
- Typical examples: improving README/docs, adding code comments, fixing typos, adding usage examples, writing tests for pure/utility functions, fixing linting/formatting issues, adding missing JSDoc/docstrings, updating outdated dependencies with clear upgrade paths, adding CI badges, creating CONTRIBUTING.md or CODE_OF_CONDUCT.md

--- REPOSITORY CONTEXT ---
Name: ${repoInfo.fullName}
Description: ${repoInfo.description}
Stars: ${repoInfo.stars} | Forks: ${repoInfo.forks}
Primary Language: ${repoInfo.language}
Language Breakdown: ${languageSummary}
License: ${repoInfo.license}
Topics: ${repoInfo.topics.join(", ") || "none"}
Open Issues Count: ${repoInfo.openIssuesCount}

${readmeSection}

--- OPEN ISSUES (most recently updated first) ---
${issuesSummary}
--- END CONTEXT ---

Based on the above, return ONLY a valid JSON object (no markdown, no explanation outside the JSON) with this exact structure:

{
  "repoAssessment": "2-3 sentence summary of the repo's current contribution-friendliness and documentation quality",
  "opportunities": [
    {
      "rank": 1,
      "title": "Short, action-oriented title",
      "type": "one of: documentation | tests | code-comments | typo-fix | examples | linting | dependency-update | ci-cd | other",
      "description": "Clear description of what needs to be done (2-4 sentences)",
      "whyQuickWin": "Why this is a good quick win (1-2 sentences)",
      "effort": "one of: XS (< 1hr) | S (1-3hrs) | M (3-8hrs)",
      "issueNumber": null or the integer issue number if directly tied to an issue,
      "issueUrl": null or the full issue URL
    }
  ]
}

Return between 5 and 10 opportunities, ranked from highest to lowest priority. Prioritize tasks that are immediately actionable. Only include issueNumber/issueUrl if the opportunity is directly tied to a specific open issue listed above.`;
}

/**
 * Calls the DeepSeek Chat Completions API and returns the parsed JSON analysis.
 *
 * @param {object} repoInfo
 * @param {object[]} issues
 * @param {object[]} languages
 * @param {string|null} readme
 * @returns {Promise<{ repoAssessment: string, opportunities: object[] }>}
 */
async function analyzeWithDeepSeek(repoInfo, issues, languages, readme) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not set. Please add it to your .env file.\n" + "Get a key at: https://platform.deepseek.com/api_keys");
  }

  const prompt = buildAnalysisPrompt(repoInfo, issues, languages, readme);

  const response = await axios.post(
    DEEPSEEK_API,
    {
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3, // Lower temperature for more consistent structured output
      max_tokens: 2048,
      response_format: { type: "json_object" }, // DeepSeek supports JSON mode
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 60000, // 60s timeout for the AI call
    },
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("DeepSeek returned an empty response.");
  }

  try {
    return JSON.parse(content);
  } catch {
    // Fallback: try to extract JSON from the response if it has extra text
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error("Could not parse DeepSeek response as JSON:\n" + content);
  }
}

// ─── Output Formatting ────────────────────────────────────────────────────────

/** Maps effort levels to colored labels */
const EFFORT_COLORS = {
  "XS (< 1hr)": chalk.green,
  "S (1-3hrs)": chalk.cyan,
  "M (3-8hrs)": chalk.yellow,
};

/** Maps opportunity types to emoji icons */
const TYPE_ICONS = {
  documentation: "📝",
  tests: "🧪",
  "code-comments": "💬",
  "typo-fix": "✏️ ",
  examples: "📖",
  linting: "🔧",
  "dependency-update": "📦",
  "ci-cd": "⚙️ ",
  other: "🔍",
};

/**
 * Prints the full analysis to stdout in a readable, color-coded format.
 *
 * @param {object} repoInfo
 * @param {object[]} issues
 * @param {object} analysis - Parsed DeepSeek response
 */
function printResults(repoInfo, issues, analysis) {
  const divider = chalk.gray("─".repeat(60));
  const boldDivider = chalk.gray("═".repeat(60));

  console.log("\n" + boldDivider);
  console.log(chalk.bold.white(`  📦 ${repoInfo.fullName}`));
  console.log(chalk.gray(`  ${repoInfo.description}`));
  console.log("");
  console.log(
    `  ⭐ ${chalk.yellow(repoInfo.stars.toLocaleString())} stars  ` +
      `🍴 ${chalk.gray(repoInfo.forks.toLocaleString())} forks  ` +
      `💬 ${chalk.cyan(issues.length)} open issues fetched  ` +
      `📋 ${chalk.cyan(repoInfo.openIssuesCount)} total`,
  );
  console.log(`  🔤 ${chalk.blue(repoInfo.language)}  ` + `📜 ${chalk.gray(repoInfo.license)}  ` + `🌐 ${chalk.gray(repoInfo.htmlUrl)}`);
  if (repoInfo.topics.length > 0) {
    console.log(`  🏷  ${repoInfo.topics.map((t) => chalk.magenta(t)).join(", ")}`);
  }
  console.log(boldDivider);

  // Repo assessment
  console.log("");
  console.log(chalk.bold.white("  📊 REPO ASSESSMENT"));
  console.log(divider);
  console.log("  " + chalk.italic.gray(analysis.repoAssessment));
  console.log("");

  // Opportunities
  console.log(chalk.bold.white("  🎯 QUICK WIN OPPORTUNITIES"));
  console.log(divider);

  const opportunities = analysis.opportunities || [];
  if (opportunities.length === 0) {
    console.log(chalk.yellow("  No opportunities identified."));
  }

  opportunities.forEach((opp, idx) => {
    const icon = TYPE_ICONS[opp.type] || "🔍";
    const effortFn = EFFORT_COLORS[opp.effort] || chalk.white;
    const typeLabel = chalk.bgGray.white(` ${(opp.type || "other").toUpperCase()} `);
    const effortLabel = effortFn(`[${opp.effort || "?"}]`);

    console.log("");
    console.log(`  ${chalk.bold.white(`#${opp.rank || idx + 1}`)}  ${icon}  ` + `${chalk.bold(opp.title)}  ${typeLabel}  ${effortLabel}`);
    console.log("");
    console.log("     " + chalk.white(opp.description));
    console.log("");
    console.log("     " + chalk.gray("💡 Why quick win: ") + chalk.italic(opp.whyQuickWin));

    if (opp.issueUrl) {
      console.log("     " + chalk.gray("🔗 Issue: ") + chalk.cyan(`#${opp.issueNumber} ${opp.issueUrl}`));
    }

    if (idx < opportunities.length - 1) {
      console.log("  " + chalk.gray("·".repeat(56)));
    }
  });

  console.log("");
  console.log(boldDivider);
  console.log(chalk.gray(`  💡 Tip: Add a GITHUB_TOKEN to .env to increase API rate limits.\n` + `  📁 Total opportunities found: ${opportunities.length}`));
  console.log(boldDivider + "\n");
}

/**
 * Writes the analysis results to a markdown file in the output folder.
 *
 * @param {object} repoInfo
 * @param {object[]} issues
 * @param {object} analysis - Parsed DeepSeek response
 * @param {string} repoName - Repository name for the filename
 */
function writeResultsToMarkdown(repoInfo, issues, analysis, repoName) {
  const outputDir = path.join(process.cwd(), "output");

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filePath = path.join(outputDir, `${repoName}.md`);
  const opportunities = analysis.opportunities || [];

  let content = `# ${repoInfo.fullName}\n\n`;
  content += `> ${repoInfo.description}\n\n`;
  content += `## Repository Info\n\n`;
  content += `| Metric | Value |\n`;
  content += `|--------|-------|\n`;
  content += `| ⭐ Stars | ${repoInfo.stars.toLocaleString()} |\n`;
  content += `| 🍴 Forks | ${repoInfo.forks.toLocaleString()} |\n`;
  content += `| 💬 Open Issues Fetched | ${issues.length} |\n`;
  content += `| 📋 Total Open Issues | ${repoInfo.openIssuesCount} |\n`;
  content += `| 🔤 Primary Language | ${repoInfo.language} |\n`;
  content += `| 📜 License | ${repoInfo.license} |\n`;
  content += `| 🌐 URL | ${repoInfo.htmlUrl} |\n`;

  if (repoInfo.topics.length > 0) {
    content += `| 🏷 Topics | ${repoInfo.topics.join(", ")} |\n`;
  }
  content += `\n`;

  // Repo assessment
  content += `## 📊 Repo Assessment\n\n`;
  content += `${analysis.repoAssessment}\n\n`;

  // Opportunities
  content += `## 🎯 Quick Win Opportunities\n\n`;

  if (opportunities.length === 0) {
    content += `*No opportunities identified.*\n`;
  } else {
    opportunities.forEach((opp, idx) => {
      const typeEmoji = TYPE_ICONS[opp.type] || "🔍";
      content += `### ${opp.rank || idx + 1}. ${typeEmoji} ${opp.title}\n\n`;
      content += `**Type:** \`${(opp.type || "other").toUpperCase()}\` | **Effort:** \`${opp.effort || "?"}\`\n\n`;
      content += `${opp.description}\n\n`;
      content += `**💡 Why quick win:** ${opp.whyQuickWin}\n\n`;

      if (opp.issueUrl) {
        content += `**🔗 Related Issue:** [#${opp.issueNumber}](${opp.issueUrl})\n\n`;
      }

      content += `---\n\n`;
    });
  }

  content += `## Summary\n\n`;
  content += `- **Total opportunities found:** ${opportunities.length}\n`;
  content += `- **Tip:** Add a \`GITHUB_TOKEN\` to \`.env\` to increase API rate limits.\n`;

  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ─── Error Helpers ────────────────────────────────────────────────────────────

/**
 * Translates common GitHub API HTTP errors into human-readable messages.
 *
 * @param {import('axios').AxiosError} err
 * @param {string} owner
 * @param {string} repo
 */
function handleGitHubError(err, owner, repo) {
  if (err.response) {
    const status = err.response.status;
    if (status === 404) {
      throw new Error(
        `Repository "${owner}/${repo}" not found.\n` + "Check the URL and ensure the repo is public (or provide a GITHUB_TOKEN for private repos).",
      );
    }
    if (status === 403 || status === 429) {
      const resetTime = err.response.headers["x-ratelimit-reset"];
      const resetDate = resetTime ? new Date(parseInt(resetTime) * 1000).toLocaleTimeString() : "unknown";
      throw new Error(
        `GitHub API rate limit exceeded. Resets at ${resetDate}.\n` + "Add a GITHUB_TOKEN to your .env file to increase the limit to 5,000 req/hr.",
      );
    }
    if (status === 401) {
      throw new Error("GitHub API authentication failed. Check your GITHUB_TOKEN.");
    }
    throw new Error(`GitHub API error: ${status} ${err.response.data?.message || ""}`);
  }
  if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
    throw new Error("Request to GitHub API timed out. Check your internet connection.");
  }
  throw err;
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────

async function main() {
  // Grab the URL argument from the command line
  const inputUrl = process.argv[2];

  console.log(chalk.bold.cyan("\n  🔍 OSS Quick Wins Finder\n"));

  // Step 1: Parse the GitHub URL
  let owner, repo;
  try {
    ({ owner, repo } = parseGitHubUrl(inputUrl));
  } catch (err) {
    console.error(chalk.red("  ❌ Invalid input: " + err.message));
    process.exit(1);
  }

  const ghClient = createGitHubClient();

  // Step 2: Fetch repo info
  const spinner = ora({ text: `Fetching repo info for ${chalk.cyan(owner + "/" + repo)}...`, color: "cyan" }).start();
  let repoInfo;
  try {
    repoInfo = await fetchRepoInfo(ghClient, owner, repo);
    spinner.succeed(`Repo found: ${chalk.cyan(repoInfo.fullName)} (${repoInfo.stars.toLocaleString()} ⭐)`);
  } catch (err) {
    spinner.fail("Failed to fetch repo info.");
    console.error(chalk.red("  ❌ " + err.message));
    process.exit(1);
  }

  // Step 3: Fetch issues, languages, and README in parallel
  spinner.start("Fetching issues, languages, and README...");
  let issues, languages, readme;
  try {
    [issues, languages, readme] = await Promise.all([
      fetchOpenIssues(ghClient, owner, repo),
      fetchLanguages(ghClient, owner, repo),
      fetchReadme(ghClient, owner, repo),
    ]);
    spinner.succeed(
      `Fetched ${chalk.cyan(issues.length)} open issues, ` +
        `${chalk.cyan(languages.length)} languages, ` +
        `README: ${readme ? chalk.green("found") : chalk.yellow("not found")}`,
    );
  } catch (err) {
    spinner.fail("Failed to fetch repository data.");
    console.error(chalk.red("  ❌ " + err.message));
    process.exit(1);
  }

  // Step 4: Analyse with DeepSeek
  spinner.start("Analyzing with DeepSeek AI (this may take up to 30s)...");
  let analysis;
  try {
    analysis = await analyzeWithDeepSeek(repoInfo, issues, languages, readme);
    spinner.succeed(`Analysis complete — ${chalk.cyan(analysis.opportunities?.length || 0)} opportunities identified.`);
  } catch (err) {
    spinner.fail("DeepSeek analysis failed.");
    if (err.response?.status === 401 || err.response?.status === 403) {
      console.error(chalk.red("  ❌ DeepSeek authentication failed. Check your DEEPSEEK_API_KEY."));
    } else if (err.response?.status === 429) {
      console.error(chalk.red("  ❌ DeepSeek rate limit hit. Please wait a moment and try again."));
    } else {
      console.error(chalk.red("  ❌ " + err.message));
    }
    process.exit(1);
  }

  // Step 5: Write the results to a markdown file
  const outputPath = writeResultsToMarkdown(repoInfo, issues, analysis, repo);
  console.log(chalk.green(`\n  ✅ Results written to: ${outputPath}\n`));
}

// ─── Entry Point ──────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error(chalk.red("\n  ❌ Unexpected error: " + err.message));
  process.exit(1);
});
