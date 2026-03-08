// Package promparse parses Prometheus text exposition format.
// Supports label-aware lookups and aggregation across label combinations.
package promparse

import (
	"bufio"
	"strconv"
	"strings"
)

type entry struct {
	labels map[string]string
	value  string
}

// Metrics holds parsed Prometheus metrics.
// Each metric name can have multiple label combinations.
type Metrics struct {
	data map[string][]entry
}

func Parse(body string) *Metrics {
	m := &Metrics{data: make(map[string][]entry)}
	scanner := bufio.NewScanner(strings.NewReader(body))

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		name, labels, value := parseLine(line)
		if name == "" {
			continue
		}

		m.data[name] = append(m.data[name], entry{labels: labels, value: value})
	}

	return m
}

// ─── First match (ignores labels) ───

func (m *Metrics) Float64(name string) float64 {
	entries := m.data[name]
	if len(entries) == 0 {
		return 0
	}
	f, err := strconv.ParseFloat(entries[0].value, 64)
	if err != nil {
		return 0
	}
	return f
}

// Int truncates float values (Prometheus sometimes writes "42.0").
func (m *Metrics) Int(name string) int {
	entries := m.data[name]
	if len(entries) == 0 {
		return 0
	}
	f, err := strconv.ParseFloat(entries[0].value, 64)
	if err != nil {
		return 0
	}
	return int(f)
}

func (m *Metrics) Uint64(name string) uint64 {
	entries := m.data[name]
	if len(entries) == 0 {
		return 0
	}
	f, err := strconv.ParseFloat(entries[0].value, 64)
	if err != nil || f < 0 {
		return 0
	}
	return uint64(f)
}

// ─── Aggregation (sum across all label combinations) ───

func (m *Metrics) SumInt(name string) int {
	var total float64
	for _, e := range m.data[name] {
		f, err := strconv.ParseFloat(e.value, 64)
		if err == nil {
			total += f
		}
	}
	return int(total)
}

func (m *Metrics) SumUint64(name string) uint64 {
	var total float64
	for _, e := range m.data[name] {
		f, err := strconv.ParseFloat(e.value, 64)
		if err == nil && f > 0 {
			total += f
		}
	}
	return uint64(total)
}

// ─── Label-filtered access ───

func (m *Metrics) Float64WithLabel(name, labelKey, labelValue string) float64 {
	for _, e := range m.data[name] {
		if e.labels[labelKey] == labelValue {
			f, err := strconv.ParseFloat(e.value, 64)
			if err != nil {
				return 0
			}
			return f
		}
	}
	return 0
}

func (m *Metrics) Uint64WithLabel(name, labelKey, labelValue string) uint64 {
	for _, e := range m.data[name] {
		if e.labels[labelKey] == labelValue {
			f, err := strconv.ParseFloat(e.value, 64)
			if err != nil || f < 0 {
				return 0
			}
			return uint64(f)
		}
	}
	return 0
}

func (m *Metrics) Has(name string) bool {
	return len(m.data[name]) > 0
}

// ─── Parser ───

// parseLine handles both labeled and unlabeled metric lines:
//
//	"metric{label=\"val\"} 42.0" → ("metric", {"label":"val"}, "42.0")
//	"metric 42.0"                → ("metric", nil, "42.0")
func parseLine(line string) (name string, labels map[string]string, value string) {
	braceIdx := strings.IndexByte(line, '{')

	var rest string
	if braceIdx >= 0 {
		name = line[:braceIdx]

		closeIdx := strings.IndexByte(line[braceIdx:], '}')
		if closeIdx < 0 {
			return "", nil, ""
		}

		labelStr := line[braceIdx+1 : braceIdx+closeIdx]
		labels = parseLabels(labelStr)

		rest = strings.TrimSpace(line[braceIdx+closeIdx+1:])
	} else {
		spaceIdx := strings.IndexByte(line, ' ')
		if spaceIdx < 0 {
			spaceIdx = strings.IndexByte(line, '\t')
			if spaceIdx < 0 {
				return "", nil, ""
			}
		}
		name = line[:spaceIdx]
		rest = strings.TrimSpace(line[spaceIdx:])
	}

	// rest: "42.0" or "42.0 1234567890" (optional timestamp)
	if spaceIdx := strings.IndexByte(rest, ' '); spaceIdx >= 0 {
		value = rest[:spaceIdx]
	} else {
		value = rest
	}

	return name, labels, value
}

func parseLabels(s string) map[string]string {
	if s == "" {
		return nil
	}

	labels := make(map[string]string)
	pairs := strings.Split(s, ",")
	for _, pair := range pairs {
		eqIdx := strings.IndexByte(pair, '=')
		if eqIdx < 0 {
			continue
		}
		key := strings.TrimSpace(pair[:eqIdx])
		val := strings.TrimSpace(pair[eqIdx+1:])
		val = strings.Trim(val, "\"")
		if key != "" {
			labels[key] = val
		}
	}

	return labels
}
