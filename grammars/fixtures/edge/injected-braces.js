// `style={{ ... }}` is the double brace that turns up in ordinary React code,
// and `.js` is where it lives when a project has no separate .jsx.
export function Badge({ label }) {
  return <span style={{ color: "red", margin: 0 }}>{label}</span>;
}

const row = `<td>{{ .Name }}</td>`;
