import { useEffect, useState } from 'react';
import type { TeamPeer } from '../shared/project';
import { Confirm, DateText, Empty, ErrorBox, PageTitle, Size, useAction, useApp } from './common';
import { useI18n } from './i18n';

export function TeamView() {
  const { t } = useI18n();
  const { state, replace, refresh, memoryPending, notify } = useApp();
  const action = useAction();
  const [invite, setInvite] = useState('');
  const [directory, setDirectory] = useState('');
  const [address, setAddress] = useState('');
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
      <div className="two-column">
        <section className="card">
          <h2>{t(team?.enabled ? 'team' : 'createTeam')}</h2>
          <p className="muted">{t('createTeamExplain')}</p>
          {state.current ? (
            <>
              <h3 className="path">{state.current.name}</h3>
              <span className="badge">{t(state.replica?.role ?? 'viewer')}</span>
              {owner && !team?.enabled ? (
                <button
                  className="primary block"
                  disabled={action.busy || !!memoryPending || state.simulation}
                  onClick={() => void action.run(() => replace(() => window.cairn.createTeam()))}
                >
                  {t('createTeam')}
                </button>
              ) : null}
              {team?.enabled ? (
                <>
                  <p className="status-pill">
                    <span
                      className={`status-dot ${state.replica?.connection === 'online' ? 'green' : ''}`}
                    />
                    {t(
                      state.replica?.connection === 'error'
                        ? 'errorState'
                        : (state.replica?.connection ?? 'offline'),
                    )}
                  </p>
                  {owner ? (
                    <>
                      <label>
                        {t('invitationRecipient')}
                        <select
                          value={memberId}
                          onChange={(e) => {
                            setMemberId(e.target.value);
                            const member = team.members?.find((m) => m.memberId === e.target.value);
                            if (member && member.role !== 'owner') setRole(member.role);
                          }}
                        >
                          <option value="">{t('newTeammate')}</option>
                          {team.members
                            ?.filter((m) => m.role !== 'owner')
                            .map((m) => (
                              <option key={m.memberId} value={m.memberId}>
                                {m.name || t('teammate')} ·{' '}
                                {t(
                                  m.revoked
                                    ? 'accessRevoked'
                                    : m.expiresAt < Date.now()
                                      ? 'expired'
                                      : m.connected
                                        ? 'online'
                                        : 'offline',
                                )}
                              </option>
                            ))}
                        </select>
                      </label>
                      {memberId ? <p className="muted">{t('renewInviteExplain')}</p> : null}
                      <label>
                        {t('inviteRole')}
                        <select
                          value={role}
                          onChange={(e) => setRole(e.target.value as typeof role)}
                        >
                          <option value="editor">{t('editor')}</option>
                          <option value="viewer">{t('viewer')}</option>
                        </select>
                      </label>
                      <details>
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
                      <button
                        className="primary block"
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
                </>
              ) : null}
            </>
          ) : (
            <Empty text="selectProject" />
          )}
        </section>
        <section className="card">
          <h2>{t('joinTeam')}</h2>
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
                <input readOnly required value={directory} />
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
            <details>
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
              className="primary block"
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
                  <button
                    disabled={action.busy || !invite || !directory}
                    onClick={() => void join()}
                  >
                    {t('transferRetry')}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      </div>
      <section className="card">
        <div className="section-line">
          <h2>{t('discovery')}</h2>
          <button
            disabled={action.busy || state.simulation}
            onClick={() =>
              void action.run(async () => {
                await window.cairn.discoverTeams();
                await refresh();
              })
            }
          >
            {t('discover')}
          </button>
        </div>
        <p className="muted">{t('discoveredHelp')}</p>
        {state.discovered.length ? (
          state.discovered.map((d) => (
            <div key={d.teamId} className="discovery-row">
              <div className="grow">
                <strong>{d.name}</strong>
                <p className="path">{d.addresses.join(', ')}</p>
                <small>
                  {t('fingerprint')} <code>{d.fingerprint}</code>
                </small>
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
      <section className="card">
        <h2>
          {t('peers')} ({team?.peers.length ?? 0})
        </h2>
        <p className="muted">{t('peersExplain')}</p>
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
          <Empty />
        )}
      </section>
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
