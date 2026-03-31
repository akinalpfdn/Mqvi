package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

type SoundboardRepository interface {
	Create(ctx context.Context, sound *models.SoundboardSound) error
	GetByID(ctx context.Context, id string) (*models.SoundboardSound, error)
	ListByServer(ctx context.Context, serverID string) ([]models.SoundboardSound, error)
	Update(ctx context.Context, sound *models.SoundboardSound) error
	Delete(ctx context.Context, id string) error
	CountByServer(ctx context.Context, serverID string) (int, error)
}
