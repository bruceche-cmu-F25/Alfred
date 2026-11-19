/** The automations Alfred ships with, in each language. Apart from automations.ts so that runs.ts can name an
 * automation's run without importing the aggregate (which imports runs). */
import type { Locale } from "./settings.ts";

export const AUTOMATION_TEMPLATES = ["brief"] as const;
export type AutomationTemplate = (typeof AUTOMATION_TEMPLATES)[number];

export const TEMPLATE_TEXT: Record<AutomationTemplate, Record<Locale, { name: string; goal: string }>> = {
  brief: {
    zh: {
      name: "早报",
      goal: "写今天的早报：今天的日程，需要我回的邮件，今天到期和已经逾期的待办，在等我决定的事，以及你建议我先做哪一件。几行就好，不要替我做决定。",
    },
    en: {
      name: "Morning brief",
      goal: "Write today's morning brief: today's schedule, mail that needs my reply, todos due today or overdue, anything waiting for my decision, and which one you suggest I start with. A few lines; don't decide anything for me.",
    },
  },
};
