// Package promparse — Prometheus text exposition format parser.
//
// Prometheus'un /metrics endpoint'inden dönen metin formatını parse eder.
// Label-aware lookup destekler — aynı metrik adıyla birden fazla label
// kombinasyonu varsa spesifik label'a göre veya toplu (sum) erişim sağlar.
//
// Prometheus text format:
//
//	# HELP metric_name Description text
//	# TYPE metric_name gauge
//	metric_name 42.0
//	metric_name{label="value"} 42.0
//
// Kullanım:
//
//	metrics := promparse.Parse(body)
//	rooms := metrics.Int("livekit_room_total")                                // ilk değer
//	tracks := metrics.SumInt("livekit_track_published_total")                 // tüm label'ların toplamı
//	bytesIn := metrics.Uint64WithLabel("livekit_packet_bytes", "direction", "incoming")
package promparse

import (
	"bufio"
	"strconv"
	"strings"
)

// entry, tek bir Prometheus metrik satırının parse edilmiş hali.
// Aynı metrik adı farklı label kombinasyonlarıyla birden fazla kez görünebilir.
type entry struct {
	labels map[string]string
	value  string
}

// Metrics, parse edilen Prometheus metriklerini tutar.
// Her metrik adı altında birden fazla label kombinasyonu olabilir.
type Metrics struct {
	data map[string][]entry
}

// Parse, Prometheus text exposition format'ını parse eder.
// Comment (#) ve boş satırları atlar, metric_name{...} value formatını parse eder.
func Parse(body string) *Metrics {
	m := &Metrics{data: make(map[string][]entry)}
	scanner := bufio.NewScanner(strings.NewReader(body))

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		// Boş satır veya comment (#HELP, #TYPE)
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

// ─── İlk Değer Erişimi (label fark etmez, ilk match) ───

// Float64, metrik değerini float64 olarak döner. Bulunamazsa 0 döner.
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

// Int, metrik değerini int olarak döner. Bulunamazsa 0 döner.
// Float değerler truncate edilir (Prometheus bazen "42.0" yazar).
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

// Uint64, metrik değerini uint64 olarak döner. Bulunamazsa 0 döner.
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

// ─── Toplama (Tüm Label Kombinasyonlarının Toplamı) ───

// SumInt, aynı metrik adındaki tüm label kombinasyonlarının değerlerini toplar.
// Örnek: livekit_track_published_total{kind="audio"} + {kind="video"} toplamı.
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

// SumUint64, aynı metrik adındaki tüm label kombinasyonlarının değerlerini toplar.
// Counter'lar gibi büyük pozitif değerler için kullanılır.
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

// ─── Label Filtreli Erişim ───

// Float64WithLabel, belirli bir label key=value eşleşen ilk entry'nin değerini döner.
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

// Uint64WithLabel, belirli bir label key=value eşleşen ilk entry'nin değerini döner.
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

// Has, metriğin var olup olmadığını kontrol eder.
func (m *Metrics) Has(name string) bool {
	return len(m.data[name]) > 0
}

// ─── Parser ───

// parseLine, tek bir Prometheus metrik satırını parse eder.
//
//	"metric_name{label=\"val\",x=\"y\"} 42.0" → ("metric_name", {"label":"val","x":"y"}, "42.0")
//	"metric_name 42.0"                        → ("metric_name", nil, "42.0")
func parseLine(line string) (name string, labels map[string]string, value string) {
	// Label var mı kontrol et
	braceIdx := strings.IndexByte(line, '{')

	var rest string
	if braceIdx >= 0 {
		// Label'lı: metric_name{...} value
		name = line[:braceIdx]

		// Closing brace'i bul
		closeIdx := strings.IndexByte(line[braceIdx:], '}')
		if closeIdx < 0 {
			return "", nil, "" // malformed
		}

		// Label string'ini parse et: key="val",key2="val2"
		labelStr := line[braceIdx+1 : braceIdx+closeIdx]
		labels = parseLabels(labelStr)

		rest = strings.TrimSpace(line[braceIdx+closeIdx+1:])
	} else {
		// Label'sız: metric_name value [timestamp]
		spaceIdx := strings.IndexByte(line, ' ')
		if spaceIdx < 0 {
			spaceIdx = strings.IndexByte(line, '\t')
			if spaceIdx < 0 {
				return "", nil, "" // malformed
			}
		}
		name = line[:spaceIdx]
		rest = strings.TrimSpace(line[spaceIdx:])
	}

	// rest: "42.0" veya "42.0 1234567890" (timestamp opsiyonel)
	if spaceIdx := strings.IndexByte(rest, ' '); spaceIdx >= 0 {
		value = rest[:spaceIdx]
	} else {
		value = rest
	}

	return name, labels, value
}

// parseLabels, Prometheus label string'ini parse eder.
//
//	'key="val",key2="val2"' → {"key":"val", "key2":"val2"}
func parseLabels(s string) map[string]string {
	if s == "" {
		return nil
	}

	labels := make(map[string]string)
	// Basit split — Prometheus label value'larında virgül olabilir ama pratikte nadir.
	// Daha robust: quote-aware parser. Şimdilik basit yaklaşım yeterli.
	pairs := strings.Split(s, ",")
	for _, pair := range pairs {
		eqIdx := strings.IndexByte(pair, '=')
		if eqIdx < 0 {
			continue
		}
		key := strings.TrimSpace(pair[:eqIdx])
		val := strings.TrimSpace(pair[eqIdx+1:])
		// Remove surrounding quotes
		val = strings.Trim(val, "\"")
		if key != "" {
			labels[key] = val
		}
	}

	return labels
}
