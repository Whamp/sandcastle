import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { GitHubIssueBacklog } from "../src/GitHubIssueBacklog.js";
import { executeNextGitHubIssueTask } from "../src/GitHubIssueSuccessPath.js";

const backlog = new GitHubIssueBacklog();

const result = await executeNextGitHubIssueTask({
  backlog,
  executeTask: ({ selectedTask, parentIssue }) =>
    sandcastle.run({
      sandbox: noSandbox(),
      name: `Task-${selectedTask.issue.number}`,
      agent: sandcastle.claudeCode("claude-opus-4-6"),
      promptFile: "./.sandcastle/implement-prompt.md",
      promptArgs: {
        ISSUE_NUMBER: String(selectedTask.issue.number),
        ISSUE_TITLE: selectedTask.issue.title,
        PARENT_ISSUE_NUMBER: parentIssue ? String(parentIssue.number) : "none",
        PARENT_ISSUE_TITLE: parentIssue?.title ?? "none",
      },
    }),
});

if (!result.selectedTask) {
  console.log("No ready GitHub Issue Task found.");
} else if (result.closed) {
  console.log(
    `Closed GitHub Issue #${result.selectedTask.issue.number} after land on ${result.runResult?.branch}.`,
  );
} else if (result.blockingPrerequisiteTask) {
  console.log(
    `GitHub Issue #${result.selectedTask.issue.number} is now blocked by prerequisite #${result.blockingPrerequisiteTask.issue.number}; the claim was released.`,
  );
} else {
  console.log(
    `GitHub Issue #${result.selectedTask.issue.number} finished without a landed change; the claim was released.`,
  );
}

if (result.proposedFollowOnTask) {
  console.log(
    `Created proposed follow-on GitHub Issue #${result.proposedFollowOnTask.issue.number} from Task #${result.selectedTask?.issue.number}.`,
  );
}

if (result.proposedFollowOnError) {
  console.warn(
    `Proposed follow-on GitHub Issue creation failed after current Task Coordination finished: ${result.proposedFollowOnError}`,
  );
}
