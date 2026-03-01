// Package promparse — Prometheus text exposition format parser.
//
// Prometheus'un /metrics endpoint'inden dönen metin formatını parse eder.
// Full parser değildir — sadece belirli metrik isimlerinin scalar değerlerini
// çıkarmak için optimize edilmiştir.
//
// Prometheus text format:
//
//	# HELP metric_name Description text
//	# TYPE metric_name gauge
//	metric_name 42.0
//	metric_name{label="value"} 42.0
//
// Bu parser label'ları ignore eder — sadece metrik adı + değer çeker.
// Aynı isimde birden fazla satır varsa (label'lı) ilk değeri alır.
//
// Kullanım:
//
//	metrics := promparse.Parse(body)
//	cpuLoad := metrics.Float64("livekit_node_sys_cpu_load")
//	rooms := metrics.Int("livekit_node_rooms")
package promparse

import (
	"bufio"
	"strconv"
	"strings"
)

// Metrics, parse edilen Prometheus metriklerini tutar.
// Key: metrik adı, Value: string representation of the value.
// Aynı metrik birden fazla label kombinasyonu ile varsa sadece ilk değer saklanır.
type Metrics map[string]string

// Parse, Prometheus text exposition format'ını parse eder.
// Comment (#) ve boş satırları atlar, metric_name{...} value formatını parse eder.
func Parse(body string) Metrics {
	m := make(Metrics)
	scanner := bufio.NewScanner(strings.NewReader(body))

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		// Boş satır veya comment (#HELP, #TYPE)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		// Format: metric_name value [timestamp]
		// veya:  metric_name{label="val",...} value [timestamp]
		name, value := parseLine(line)
		if name == "" {
			continue
		}

		// Aynı metrik adı zaten varsa skip (ilk label set'i yeterli)
		if _, exists := m[name]; !exists {
			m[name] = value
		}
	}

	return m
}

// Float64, metrik değerini float64 olarak döner. Bulunamazsa 0 döner.
func (m Metrics) Float64(name string) float64 {
	v, ok := m[name]
	if !ok {
		return 0
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0
	}
	return f
}

// Int, metrik değerini int olarak döner. Bulunamazsa 0 döner.
// Float değerler truncate edilir.
func (m Metrics) Int(name string) int {
	v, ok := m[name]
	if !ok {
		return 0
	}
	// Önce float olarak parse et (Prometheus bazen "42.0" yazar)
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0
	}
	return int(f)
}

// Uint64, metrik değerini uint64 olarak döner. Bulunamazsa 0 döner.
// Counter'lar gibi büyük pozitif değerler için kullanılır.
func (m Metrics) Uint64(name string) uint64 {
	v, ok := m[name]
	if !ok {
		return 0
	}
	// Önce float olarak parse et (Prometheus counter'lar float olabilir)
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0
	}
	if f < 0 {
		return 0
	}
	return uint64(f)
}

// Has, metriğin var olup olmadığını kontrol eder.
func (m Metrics) Has(name string) bool {
	_, ok := m[name]
	return ok
}

// parseLine, tek bir Prometheus metrik satırını parse eder.
// "metric_name{label="val"} 42.0" → ("metric_name", "42.0")
// "metric_name 42.0" → ("metric_name", "42.0")
func parseLine(line string) (name, value string) {
	// Label var mı kontrol et
	braceIdx := strings.IndexByte(line, '{')

	var rest string
	if braceIdx >= 0 {
		// Label'lı: metric_name{...} value
		name = line[:braceIdx]

		// Closing brace'i bul
		closeIdx := strings.IndexByte(line[braceIdx:], '}')
		if closeIdx < 0 {
			return "", "" // malformed
		}
		rest = strings.TrimSpace(line[braceIdx+closeIdx+1:])
	} else {
		// Label'sız: metric_name value [timestamp]
		spaceIdx := strings.IndexByte(line, ' ')
		if spaceIdx < 0 {
			// Tab da olabilir
			spaceIdx = strings.IndexByte(line, '\t')
			if spaceIdx < 0 {
				return "", "" // malformed
			}
		}
		name = line[:spaceIdx]
		rest = strings.TrimSpace(line[spaceIdx:])
	}

	// rest: "42.0" veya "42.0 1234567890" (timestamp opsiyonel)
	// İlk space'e kadar al (timestamp varsa at)
	if spaceIdx := strings.IndexByte(rest, ' '); spaceIdx >= 0 {
		value = rest[:spaceIdx]
	} else {
		value = rest
	}

	return name, value
}
