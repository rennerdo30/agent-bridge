import { expect, it } from "vitest";
import { filterJobs, groups, questionList, stats } from "../src/view-model";
import { jobs, question, sessions } from "../review/fixtures";
it("does not claim total/today metrics for bounded pages", () => { expect(stats(sessions,jobs,true).map(s => s.label)).toEqual(["working · loaded","sessions · loaded","failed · loaded"]); });
it("prioritizes urgent/blocking then oldest and separates history", () => { const old={...question,id:"old",urgency:"normal" as const,askedAt:1}, urgent={...question,id:"urgent",blocking:false}, closed={...old,id:"closed",status:"answered" as const}; expect(questionList([old,urgent,closed,question],false).map(q=>q.id)).toEqual(["q1","urgent","old"]); expect(questionList([old,closed],true).map(q=>q.id)).toEqual(["closed"]); });
it("progress churn cannot reorder working rows", () => { const more={...jobs[0]!,id:"j3",title:"Another task"}; const ids=filterJobs([...jobs,more],"working").map(j=>j.id); expect(filterJobs([...jobs.map(j=>({...j,progress:{...j.progress,percent:90}})),more],"working").map(j=>j.id)).toEqual(ids); });
it("groups opaque project identity without invented metadata", () => { expect(groups(sessions,"codex")).toEqual([{title:"Project 1",sessions:[sessions[0]]}]); expect(groups(sessions,"absent")).toEqual([]); });
