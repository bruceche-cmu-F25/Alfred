/** A unified diff, line by line: additions, removals, hunk heads; file headers are left out. */
export function Diff({ patch, className }: { patch: string; className?: string }) {
  const lines = patch.replace(/\n$/, "").split("\n").filter((line) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|={10,})/.test(line));
  return (
    <pre className={className ? `diff ${className}` : "diff"}>
      {lines.map((line, index) => {
        const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("\\") ? "note" : undefined;
        return <span key={index} data-line={kind}>{line || " "}{"\n"}</span>;
      })}
    </pre>
  );
}
