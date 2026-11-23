import { Text } from "./layout/Text";
import type { PrepTaskView } from "../types";

function amount(q: PrepTaskView["quantity"][number]): string {
  if (q.food === null) return "";
  return q.value === null ? q.food : `${q.value} ${q.unit ?? ""} ${q.food}`.replace(/\s+/g, " ");
}

function detail(task: PrepTaskView): string {
  const quantity = task.quantity.map(amount).filter(Boolean).join(", ");
  const meals = [...new Set(task.for.map((f) => f.meal))].join(", ");
  const who = task.who === "cook" ? "the cook" : task.who === "anyone" ? "anyone" : task.assignees.join(" and ");
  return [quantity, meals ? `for ${meals}` : "", who].filter(Boolean).join(" · ");
}

/** Today's and tonight's prep from the active plan: what to do, for which meals, and who does it. */
export function PrepStrip({ tasks }: { tasks: PrepTaskView[] }) {
  if (tasks.length === 0) return null;
  return (
    <section className="strip" id="prep" aria-label="Prep">
      <ul>
        {tasks.map((task) => {
          const detailText = detail(task);
          return (
            <li key={task.id} className="needs">
              <Text as="p">{`${task.action}${detailText ? ` — ${detailText}` : ""}`}</Text>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
