// Package database — Transaction yönetimi.
//
// WithTx, birden fazla DB operasyonunun atomik (all-or-nothing) çalışmasını sağlar.
//
// Transaction nedir?
// Normal DB operasyonlarında her query bağımsız commit edilir.
// Eğer 4 adımlık bir işlemde 3. adım başarısız olursa, ilk 2 adım
// DB'de kalır — tutarsız (inconsistent) veri oluşur.
//
// Transaction ile tüm adımlar tek bir birim olarak çalışır:
// - Hepsi başarılı → COMMIT (kalıcı yaz)
// - Herhangi biri başarısız → ROLLBACK (hiçbirini yazma)
//
// Kullanım:
//
//	err := database.WithTx(ctx, db.Conn, func(tx *sql.Tx) error {
//	    if _, err := tx.ExecContext(ctx, "INSERT ...", ...); err != nil {
//	        return err  // → ROLLBACK tetiklenir
//	    }
//	    if _, err := tx.ExecContext(ctx, "INSERT ...", ...); err != nil {
//	        return err  // → ROLLBACK tetiklenir
//	    }
//	    return nil  // → COMMIT
//	})
//
// Repository'ler ile kullanım:
// Repository'ler *sql.DB alır, ama WithTx *sql.Tx verir.
// İkisi de database/sql.Querier interface'ini karşılar:
// QueryContext, ExecContext, QueryRowContext.
// Bu yüzden repository'ler Querier interface'i kabul edecek şekilde
// genişletilebilir (bkz. TxQuerier).
package database

import (
	"context"
	"database/sql"
	"fmt"
)

// TxQuerier, hem *sql.DB hem *sql.Tx tarafından karşılanan interface.
//
// Repository'ler bu interface'i dependency olarak alırsa,
// normal operasyonlarda *sql.DB, transaction içinde *sql.Tx geçilebilir.
//
// Go'nun database/sql paketinde bu interface tanımlı değildir —
// biz kendimiz tanımlıyoruz (Go duck typing sayesinde hem DB hem Tx karşılar).
type TxQuerier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// WithTx, verilen fonksiyonu bir SQL transaction içinde çalıştırır.
//
// Davranış:
// 1. BEGIN TRANSACTION
// 2. fn(tx) çağır
// 3. fn nil dönerse → COMMIT
// 4. fn error dönerse → ROLLBACK
// 5. fn panic atarsa → ROLLBACK + panic'i tekrar fırlat (recover + re-panic)
//
// Panic recovery neden gerekli?
// Eğer fn içinde beklenmeyen bir panic olursa, ROLLBACK yapılmadan
// transaction açık kalır — bu DB lock'a neden olabilir.
// recover ile panic yakalanır, ROLLBACK yapılır, sonra panic tekrar fırlatılır.
func WithTx(ctx context.Context, db *sql.DB, fn func(tx *sql.Tx) error) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}

	// Panic veya error durumunda rollback garantisi
	defer func() {
		if p := recover(); p != nil {
			// Panic yakalandı — rollback yap, sonra panic'i tekrar fırlat
			_ = tx.Rollback()
			panic(p)
		}

		if err != nil {
			// fn error döndü — rollback
			if rbErr := tx.Rollback(); rbErr != nil {
				// Rollback da başarısız olduysa, her iki hatayı birleştir
				err = fmt.Errorf("%w (rollback also failed: %v)", err, rbErr)
			}
			return
		}

		// fn başarılı — commit
		if commitErr := tx.Commit(); commitErr != nil {
			err = fmt.Errorf("failed to commit transaction: %w", commitErr)
		}
	}()

	err = fn(tx)
	return
}
