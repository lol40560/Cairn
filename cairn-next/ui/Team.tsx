import { useEffect, useRef, useState } from 'react';
import type { TeamPeer } from '../shared/project';
import { Confirm, DateText, Empty, ErrorBox, PageTitle, Size, useAction, useApp } from './common';
import { Icon } from './Icon';
import { useI18n } from './i18n';

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <div className="team-choice">
      <span className="team-field-label">{label}</span>
      <details
        ref={ref}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            ref.current?.removeAttribute('open');
            ref.current?.querySelector('summary')?.focus();
          }
        }}
      >
        <summary aria-label={label}>
          {options.find((item) => item.value === value)?.label}
          <Icon name="chevronDown" />
        </summary>
        <div className="team-choice-options" role="group" aria-label={label}>
          {options.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name={label}
                value={option.value}
                checked={value === option.value}
                onChange={() => {
                  onChange(option.value);
                  ref.current?.removeAttribute('open');
                  ref.current?.querySelector('summary')?.focus();
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}

export function TeamView() {
  const { t } = useI18n();
  const { state, replace, refresh, memoryPending, notify } = useApp();
  const action = useAction();
  const [invite, setInvite] = useState('');
  const [directory, setDirectory] = useState('');
  const [address, setAddress] = useState('');
  const [sharePage, setSharePage] = useState(() => localStorage.getItem('cairn-share-page') ?? 'https://cairninvite.edgeone.dev/');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [memberId, setMemberId] = useState('');
  const [proof, setProof] = useState<{ fingerprint: string; expiresAt: number } | null>(null);
  const [revoke, setRevoke] = useState<TeamPeer | null>(null);
  const [leave, setLeave] = useState(false);
  const transfer = state.replica?.transfer;
  const activeTransfer =
    transfer && !['idle', 'ready', 'cancelled', 'error'].includes(transfer.stage);
  const team = state.team ?? state.replica?.team;
  const owner = state.replica?.role === 'owner';
  useEffect(() => {
    setProof(null);
    setRevoke(null);
    setLeave(false);
    setMemberId('');
  }, [state.current?.projectId]);
  const join = () =>
    action.run(async () => {
      await replace(() =>
        window.cairn.joinTeam({
          invite,
          directory,
          name: state.preferences.displayName,
          ...(address.trim() ? { address: address.trim() } : {}),
        }),
      );
    });
  return (
    <div className="page team-page">
      <PageTitle title="team">
        <button
          onClick={() =>
            void action.run(async () => {
              await window.cairn.copyDiagnostics();
              notify(t('copied'));
            })
          }
        >
          {t('diagnostics')}
        </button>
      </PageTitle>
      <ErrorBox error={action.error || transfer?.error || state.replica?.error} />
      <section className="card team-status">
        <div className="section-line">
          <div>
            <h2>{t('currentTeamStatus')}</h2>
            <p className="muted">{team?.enabled ? team.name : t('createTeamExplain')}</p>
          </div>
          {state.current ? (
            <div className="team-status-badges">
              <span className="badge">{t(state.replica?.role ?? 'viewer')}</span>
              {team?.enabled ? (
                <span className="status-pill">
                  <span
                    className={`status-dot ${state.replica?.connection === 'online' ? 'green' : ''}`}
                  />
                  {t(
                    state.replica?.connection === 'error'
                      ? 'errorState'
                      : (state.replica?.connection ?? 'offline'),
                  )}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {!state.current ? (
          <Empty text="selectProject" />
        ) : owner && !team?.enabled ? (
          <button
            className="primary"
            disabled={action.busy || !!memoryPending || state.simulation}
            onClick={() => void action.run(() => replace(() => window.cairn.createTeam()))}
          >
            {t('createTeam')}
          </button>
        ) : null}
        {transfer && transfer.stage !== 'idle' ? (
          <div className="transfer" aria-live="polite">
            <strong>{t(transfer.stage === 'error' ? 'errorState' : transfer.stage)}</strong>
            <progress max={transfer.totalBytes || 1} value={transfer.doneBytes} />
            <p>
              <Size bytes={transfer.doneBytes} /> / <Size bytes={transfer.totalBytes} />
            </p>
            <div className="actions">
              {activeTransfer ? (
                <button
                  onClick={() =>
                    void window.cairn.cancelJoin().then(refresh).catch(action.setError)
                  }
                >
                  {t('cancel')}
                </button>
              ) : ['error', 'cancelled'].includes(transfer.stage) ? (
                <button disabled={action.busy || !invite || !directory} onClick={() => void join()}>
                  {t('transferRetry')}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
      <section className="card team-members">
        <h2>{t('manageTeammates')}</h2>
        {team?.enabled && owner ? (
          <>
            <div className="team-invite-form">
              <Choice
                label={t('invitationRecipient')}
                value={memberId}
                options={[
                  { value: '', label: t('newTeammate') },
                  ...(team.members ?? [])
                    .filter((m) => m.role !== 'owner')
                    .map((m) => ({
                      value: m.memberId,
                      label: `${m.name || t('teammate')} · ${t(m.revoked ? 'accessRevoked' : m.expiresAt < Date.now() ? 'expired' : m.connected ? 'online' : 'offline')}`,
                    })),
                ]}
                onChange={(id) => {
                  setMemberId(id);
                  const member = team.members?.find((m) => m.memberId === id);
                  if (member && member.role !== 'owner') setRole(member.role);
                }}
              />
              <Choice
                label={t('inviteRole')}
                value={role}
                options={[
                  { value: 'editor', label: t('editor') },
                  { value: 'viewer', label: t('viewer') },
                ]}
                onChange={(value) => setRole(value as typeof role)}
              />
              <button
                className="primary"
                disabled={action.busy || state.simulation}
                onClick={() =>
                  void action.run(async () => {
                    const value = await window.cairn.copyInvite({
                      role,
                      ...(memberId ? { memberId } : {}),
                      ...(address.trim() ? { address: address.trim() } : {}),
                    });
                    setProof(value);
                    notify(t('copied'));
                  })
                }
              >
                {t('copyInvite')}
              </button>
            </div>
            <div className="team-share-link">
              <label>
                {t('sharePageUrl')}
                <input
                  type="url"
                  value={sharePage}
                  placeholder="https://example.com/cairn-invite.html"
                  onChange={(event) => setSharePage(event.target.value)}
                />
              </label>
              <button
                disabled={action.busy || state.simulation || !sharePage.trim()}
                onClick={() =>
                  void action.run(async () => {
                    const value = await window.cairn.copyInvite({
                      role,
                      ...(memberId ? { memberId } : {}),
                      ...(address.trim() ? { address: address.trim() } : {}),
                      sharePageUrl: sharePage.trim(),
                    });
                    localStorage.setItem('cairn-share-page', sharePage.trim());
                    setProof(value);
                    notify(t('shareLinkCopied'));
                  })
                }
              >
                {t('copyShareLink')}
              </button>
              <p className="muted">{t('sharePageHelp')}</p>
              <ErrorBox error={action.error} />
            </div>
            {memberId ? <p className="muted">{t('renewInviteExplain')}</p> : null}
            <details className="team-advanced">
              <summary>{t('advanced')}</summary>
              <label>
                {t('address')}
                <input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="wss://192.168.1.10:43190/team"
                />
              </label>
              <p className="muted">{t('directHelp')}</p>
              <div className="path-list">
                {team.addresses.map((a) => (
                  <code key={a}>{a}</code>
                ))}
              </div>
            </details>
            {proof ? (
              <div className="fingerprint">
                <strong>{t('fingerprint')}</strong>
                <code>{proof.fingerprint}</code>
                <small>
                  {t('expires')} · <DateText time={proof.expiresAt} />
                </small>
              </div>
            ) : null}
          </>
        ) : null}
        <h3>
          {t('peers')} ({team?.peers.length ?? 0})
        </h3>
        {team?.peers.length ? (
          <ul className="peer-list">
            {team.peers.map((peer) => (
              <li key={peer.clientId}>
                <span className="avatar">{peer.name.slice(0, 1)}</span>
                <div className="grow">
                  <strong>{peer.name}</strong>
                  <small>
                    {t(peer.role)} ·{' '}
                    {t(
                      peer.projection === 'applied'
                        ? 'diskApplied'
                        : peer.projection === 'pending'
                          ? 'diskPending'
                          : 'diskBlocked',
                    )}
                  </small>
                </div>
                {owner && peer.role !== 'owner' ? (
                  <button className="quiet danger-text" onClick={() => setRevoke(peer)}>
                    {t('revoke')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="team-empty">{t(team?.enabled ? 'onlyTeammate' : 'noTeamYet')}</p>
        )}
      </section>
      <section className="card team-join">
        <h2>{t('joinNewTeam')}</h2>
        <p className="muted">{t('joinExplain')}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void join();
          }}
        >
          <label>
            {t('invite')}
            <textarea
              aria-label={t('invite')}
              placeholder={t('invitePlaceholder')}
              required
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              rows={4}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label>
            {t('joinDirectory')}
            <div className="folder-picker">
              <input readOnly required value={directory} placeholder="~/Documents/..." />
              <button
                type="button"
                disabled={action.busy || !!activeTransfer}
                onClick={() =>
                  void action.run(async () => {
                    const path = await window.cairn.chooseFolder();
                    if (path) setDirectory(path);
                  })
                }
              >
                {t('choose')}
              </button>
            </div>
          </label>
          <details className="team-advanced">
            <summary>{t('advanced')}</summary>
            <label>
              {t('address')}
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="wss://192.168.1.10:43190/team"
              />
            </label>
            <p className="muted">{t('directHelp')}</p>
          </details>
          <button
            className="primary"
            disabled={
              !invite.trim() ||
              !directory ||
              action.busy ||
              !!memoryPending ||
              !!activeTransfer ||
              state.simulation
            }
          >
            {t('joinTeam')}
          </button>
        </form>
      </section>
      <section className="card">
        <div className="section-line">
          <h2>{t('discovery')}</h2>
          <button
            className="quiet icon team-refresh"
            aria-label={t('discover')}
            title={t('discover')}
            disabled={action.busy || state.simulation}
            onClick={() =>
              void action.run(async () => {
                await window.cairn.discoverTeams();
                await refresh();
              })
            }
          >
            <Icon name="refresh" />
          </button>
        </div>
        <p className="muted">{t('discoveredHelp')}</p>
        {state.discovered.length ? (
          state.discovered.map((d) => (
            <div key={d.teamId} className="discovery-row">
              <div className="grow">
                <strong>{d.name}</strong>
                <details>
                  <summary>{t('advanced')}</summary>
                  <p className="path">{d.addresses.join(', ')}</p>
                  <small>
                    {t('fingerprint')} <code>{d.fingerprint}</code>
                  </small>
                </details>
              </div>
              <button disabled={!d.addresses.length} onClick={() => setAddress(d.addresses[0]!)}>
                {t('useAddress')}
              </button>
            </div>
          ))
        ) : (
          <Empty />
        )}
      </section>
      {team?.enabled ? (
        <section className="card team-danger">
          <h2>{t('advancedActions')}</h2>
          <p className="muted">{t('advancedActionsHelp')}</p>
          <div className="actions">
            <button
              disabled={action.busy}
              onClick={() => void action.run(() => window.cairn.reconnect())}
            >
              {t('reconnect')}
            </button>
            <button
              className="danger"
              disabled={action.busy || !!memoryPending}
              onClick={() => setLeave(true)}
            >
              {t('leave')}
            </button>
          </div>
        </section>
      ) : null}
      {revoke ? (
        <Confirm
          title="revoke"
          description="revokeExplain"
          onClose={() => setRevoke(null)}
          onConfirm={async () => {
            await window.cairn.revokeMember(revoke.memberId);
            await refresh();
          }}
        >
          <strong>{revoke.name}</strong>
        </Confirm>
      ) : null}
      {leave ? (
        <Confirm
          title="leave"
          description="leaveExplain"
          onClose={() => setLeave(false)}
          onConfirm={async () => {
            await window.cairn.leaveTeam();
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}
