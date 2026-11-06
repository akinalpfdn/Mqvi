// Package services — microphone health reports from clients.
package services

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/akinalp/mqvi/models"
)

// RecordMicHealth writes one row per change in a mic episode: "dead" when the client declares the
// mic dead, "recovered" or "left_voice" when that ends. A healthy session writes nothing, so every
// row in the category is a person who could not be heard.
//
// The cause and the platform are in the message, not only the metadata: the log list is scanned by
// eye, and those two are what narrow a report first.
func (s *voiceService) RecordMicHealth(userID string, r models.MicHealthReport) {
	if s.appLogger == nil {
		return
	}
	metadata := map[string]string{
		"event":       r.Event,
		"fault":       r.Fault,
		"intent":      r.Intent,
		"platform":    r.Platform,
		"processor":   r.Processor,
		"channel_id":  r.ChannelID,
		"duration_ms": strconv.FormatInt(r.DurationMs, 10),
	}
	if r.AppVersion != "" {
		metadata["app_version"] = r.AppVersion
	}
	if len(r.Faults) > 0 {
		metadata["faults"] = strings.Join(r.Faults, " → ")
	}
	if r.SinceReconnectMs >= 0 {
		metadata["since_reconnect_ms"] = strconv.FormatInt(r.SinceReconnectMs, 10)
	} else {
		metadata["since_reconnect_ms"] = "none"
	}
	if len(r.Trail) > 0 {
		metadata["trail"] = formatMicTrail(r.Trail)
	}
	if r.Detail != "" {
		metadata["detail"] = r.Detail
	}

	secs := float64(r.DurationMs) / 1000
	switch r.Event {
	case "dead":
		s.appLogger.Log(models.LogLevelWarn, models.LogCategoryMic, &userID, nil,
			fmt.Sprintf("mic dead: %s (%s, %s)", r.Fault, r.Platform, r.Intent), metadata)
	case "recovered":
		s.appLogger.Log(models.LogLevelInfo, models.LogCategoryMic, &userID, nil,
			fmt.Sprintf("mic recovered after %.1fs: %s (%s)", secs, r.Fault, r.Platform), metadata)
	case "left_voice":
		s.appLogger.Log(models.LogLevelWarn, models.LogCategoryMic, &userID, nil,
			fmt.Sprintf("mic still dead when the user left voice after %.1fs: %s (%s)", secs, r.Fault, r.Platform), metadata)
	}
}

// formatMicTrail renders the trail oldest first, each entry as its offset before the report.
func formatMicTrail(trail []models.MicTrailEntry) string {
	sorted := append([]models.MicTrailEntry(nil), trail...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].AgoMs > sorted[j].AgoMs })
	parts := make([]string, len(sorted))
	for i, e := range sorted {
		parts[i] = fmt.Sprintf("-%.1fs %s", float64(e.AgoMs)/1000, e.Event)
	}
	return strings.Join(parts, " · ")
}
