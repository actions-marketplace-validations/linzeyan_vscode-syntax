package main

import "text/template"

// The `{{ }}` injection's home: a template written inside the Go source that
// executes it. The second string is not a template at all.
var page = template.Must(template.New("page").Parse(`
<h1>{{ .Title }}</h1>
{{ range .Items }}<li>{{ . }}</li>{{ end }}
`))

const shrug = "curly braces {{ in an ordinary string }}"
