import { useMemo } from 'react';
import type { ActivityEntry } from '../shared/project';
import { Empty, ErrorBox, NeedProject, PageTitle, useApp, useQuery } from './common';
import { useI18n } from './i18n';

function dayKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function Overview() {
  const { t, locale } = useI18n();
  const { state } = useApp();
  const query = useQuery<ActivityEntry[]>({ kind: 'activity', limit: 1000 });
  const data = useMemo(() => {
    const entries = (query.data ?? []).filter((e) => e.paths.length > 0);
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const key = dayKey(new Date(entry.time));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const days = Array.from({ length: 91 }, (_, i) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (90 - i));
      return { date, count: counts.get(dayKey(date)) ?? 0 };
    });
    const recent = days.slice(-7);
    return {
      entries,
      days,
      recent,
      max: Math.max(1, ...recent.map((d) => d.count)),
      paths: new Set(entries.flatMap((e) => e.paths)).size,
      authors: new Set(entries.map((e) => e.actor.id)).size,
    };
  }, [query.data]);
  return (
    <NeedProject>
      <div className="page overview-page">
        <PageTitle title="overview" />
        <p className="muted">{t('overviewScope')}</p>
        <ErrorBox error={query.error} />
        {query.loading ? (
          <Empty text="loading" />
        ) : query.error ? null : (
          <>
            <div className="overview-stats">
              <section className="card">
                <span>{t('overviewChanges')}</span>
                <strong>{data.entries.length}</strong>
                <small>{t('overviewSample')}</small>
              </section>
              <section className="card">
                <span>{t('overviewFiles')}</span>
                <strong>{data.paths}</strong>
                <small>{t('overviewSample')}</small>
              </section>
              <section className="card">
                <span>{t('overviewContributors')}</span>
                <strong>{data.authors}</strong>
                <small>{t('overviewSample')}</small>
              </section>
              <section className="card">
                <span>{t('overviewOpenConflicts')}</span>
                <strong>
                  {state.replica?.metadata.conflicts.filter((c) => c.status === 'open').length ?? 0}
                </strong>
                <small>{t('overviewCurrent')}</small>
              </section>
            </div>
            <section className="card overview-card">
              <h2>{t('overviewActivity')}</h2>
              <p className="muted">{t('overviewActivityHelp')}</p>
              <div className="activity-grid" role="group" aria-label={t('overviewActivity')}>
                {data.days.map(({ date, count }) => {
                  const label = `${date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })}: ${count} ${t('overviewEvents')}`;
                  return (
                    <span
                      key={dayKey(date)}
                      className={`activity-cell level-${Math.min(count, 4)}`}
                      title={label}
                      aria-label={label}
                      role="img"
                    />
                  );
                })}
              </div>
              <p className="overview-legend">
                <span>{t('overviewLess')}</span>
                <span className="activity-cell level-0" />
                <span className="activity-cell level-1" />
                <span className="activity-cell level-2" />
                <span className="activity-cell level-3" />
                <span className="activity-cell level-4" />
                <span>{t('overviewMore')}</span>
              </p>
            </section>
            <section className="card overview-card">
              <h2>{t('overviewWeek')}</h2>
              <div className="overview-bars" role="group" aria-label={t('overviewWeek')}>
                {data.recent.map(({ date, count }) => (
                  <div
                    className="overview-bar-column"
                    key={dayKey(date)}
                    title={`${date.toLocaleDateString(locale)}: ${count}`}
                  >
                    <span className="overview-bar-count">{count}</span>
                    <div className="overview-bar-track">
                      <div
                        className="overview-bar"
                        style={{ height: `${count ? Math.max(5, (count / data.max) * 100) : 0}%` }}
                      />
                    </div>
                    <span>{date.toLocaleDateString(locale, { weekday: 'short' })}</span>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </NeedProject>
  );
}
