import { useEffect, useMemo, useRef, useState } from "react";
import { FileName } from "../../components/FileName";
import { LtrValue } from "../../components/LtrValue";
import {
  he,
  linkAccessPeopleCountLabel,
  linkExpirySummaryLabel,
  linkFileSavedInOrgLabel,
} from "../../copy/he";
import { FluentIcon, type IconName } from "../../icons/fluent";
import {
  DESIGN_CLOUD_FILE,
  DESIGN_COMPUTER_FILE,
  DESIGN_LINK_URL,
} from "./designLink";
import {
  addEmailChip,
  canCreateExternalLink,
  clampExpiry,
  datetimeLocalValue,
  expiresAtFromPreset,
  formatFileSize,
  formatLinkExpiryParts,
  linkFixturesEnabled,
  maxExpiryAt,
  type LinkAccess,
  type LinkExpiryPreset,
  type LinkPickedFile,
  type LinkProvider,
  type LinkSharePolicy,
  type LinkStage,
} from "./externalLinkForm";

type ExternalLinkScreenProps = {
  policy?: LinkSharePolicy;
  initialStage?: LinkStage;
  onBack: () => void;
  onClose: () => void;
};

const PROVIDER_LABEL: Record<LinkProvider, string> = {
  sharepoint: he.providerSharePoint,
  google: he.providerGoogleWorkspace,
  dropbox: he.providerDropbox,
};

function fileKindIcon(name: string): IconName {
  return name.toLowerCase().includes(".") ? "document" : "attach";
}

export function ExternalLinkScreen({
  policy = "anyone",
  initialStage = "form",
  onBack,
  onClose,
}: ExternalLinkScreenProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const seeded = initialStage !== "form";
  const [stage, setStage] = useState<LinkStage>(initialStage);
  const [picked, setPicked] = useState<LinkPickedFile | null>(seeded ? DESIGN_COMPUTER_FILE : null);
  const [dropActive, setDropActive] = useState(false);
  const [access, setAccess] = useState<LinkAccess>(policy === "identified" ? "people" : "anyone");
  const [emails, setEmails] = useState<string[]>(
    seeded && policy === "identified" ? ["dana@drops.app", "lee@company.com"] : [],
  );
  const [emailDraft, setEmailDraft] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<LinkExpiryPreset>("7d");
  const [now] = useState(() => new Date());
  const [customValue, setCustomValue] = useState(() => datetimeLocalValue(clampExpiry(
    new Date(now.getTime() + 7 * 86_400_000),
    now,
    maxExpiryAt(now, policy),
  )));
  const [copied, setCopied] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [openedHint, setOpenedHint] = useState(false);

  const publicBlocked = policy === "identified";
  const maxExpiresAt = useMemo(() => maxExpiryAt(now, policy), [now, policy]);
  const expiresAt = useMemo(
    () => expiresAtFromPreset(expiry, customValue, now),
    [expiry, customValue, now],
  );
  const canCreate = canCreateExternalLink({
    file: picked,
    access,
    validEmails: emails,
    expiresAt,
    now,
    maxExpiresAt,
  });
  const expirySummary = expiresAt && expiresAt.getTime() > now.getTime()
    ? linkExpirySummaryLabel(
        formatLinkExpiryParts(expiresAt).date,
        formatLinkExpiryParts(expiresAt).time,
      )
    : null;

  useEffect(() => {
    if (publicBlocked && access === "anyone") {
      setAccess("people");
    }
  }, [access, publicBlocked]);

  useEffect(() => {
    if (stage !== "uploading" || !linkFixturesEnabled() || import.meta.env.MODE === "test") {
      return;
    }
    if (initialStage === "uploading") {
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wait = reduced ? 0 : 1600;
    const timer = window.setTimeout(() => {
      setStage("success");
    }, wait);
    return () => window.clearTimeout(timer);
  }, [initialStage, stage]);

  function pickFromComputer() {
    fileInputRef.current?.click();
  }

  function applyLocalFile(file: File) {
    setPicked({
      name: file.name,
      size: file.size,
      source: "computer",
      provider: "sharepoint",
    });
  }

  function commitEmails(raw: string): boolean {
    const result = addEmailChip(emails, raw);
    if (result.invalid) {
      setEmailError(he.linkEmailInvalid);
      setEmailDraft(result.invalid);
      setEmails(result.emails);
      return false;
    }
    if (result.consumed) {
      setEmails(result.emails);
      setEmailDraft("");
      setEmailError(null);
      return true;
    }
    return false;
  }

  function onCreate() {
    if (!canCreate || !linkFixturesEnabled()) {
      return;
    }
    setStage("uploading");
  }

  function resetForm() {
    setStage("form");
    setPicked(null);
    setAccess(publicBlocked ? "people" : "anyone");
    setEmails([]);
    setEmailDraft("");
    setEmailError(null);
    setExpiry("7d");
    setCopied(false);
    setRevokeOpen(false);
    setOpenedHint(false);
  }

  async function copyLink() {
    if (!linkFixturesEnabled()) {
      return;
    }
    try {
      await navigator.clipboard.writeText(DESIGN_LINK_URL);
    } catch {
      /* fixture illustration only */
    }
    setCopied(true);
  }

  function openLink() {
    if (!linkFixturesEnabled()) {
      return;
    }
    setOpenedHint(true);
  }

  const peopleOpen = access === "people";
  const customOpen = expiry === "custom";

  return (
    <div
      className="fr-compose-send fr-compose-link"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compose-title"
    >
      <div className="fr-compose-form-nav">
        <button type="button" className="fr-header-back" onClick={onBack}>
          <FluentIcon name="chevronLeft" rtlFlip />
          {he.back}
        </button>
        <button
          type="button"
          className="fr-icon-btn"
          aria-label={he.closeDialog}
          onClick={onClose}
        >
          <FluentIcon name="dismiss" />
        </button>
      </div>

      {stage === "form" ? (
        <div className="fr-compose-send-body fr-link-stage">
          <div>
            <h2 id="compose-title" className="fr-compose-form-title">
              <FluentIcon name="link" size={18} />
              {he.createExternalLink}
            </h2>
            <p className="fr-hint fr-link-lead">{he.externalLinkHint}</p>
          </div>

          <div className="fr-compose-link-fields">
            <input
              ref={fileInputRef}
              type="file"
              className="fr-file-input"
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  applyLocalFile(file);
                }
                event.target.value = "";
              }}
            />
            {picked ? (
              <div className="fr-link-file">
                <FluentIcon name={fileKindIcon(picked.name)} size={18} />
                <div className="fr-link-file-meta">
                  <FileName name={picked.name} className="fr-dropzone-name" />
                  <span className="fr-hint">
                    <LtrValue>{formatFileSize(picked.size)}</LtrValue>
                    {" · "}
                    {PROVIDER_LABEL[picked.provider]}
                  </span>
                </div>
                <button
                  type="button"
                  className="fr-icon-btn"
                  aria-label={he.replaceFile}
                  onClick={pickFromComputer}
                >
                  <FluentIcon name="arrowSync" />
                </button>
                <button
                  type="button"
                  className="fr-icon-btn"
                  aria-label={he.removeFile}
                  onClick={() => {
                    setPicked(null);
                  }}
                >
                  <FluentIcon name="delete" />
                </button>
              </div>
            ) : (
              <div
                className={`fr-dropzone${dropActive ? " fr-drop-active" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={he.chooseFile}
                onClick={pickFromComputer}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    pickFromComputer();
                  }
                }}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDropActive(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                    setDropActive(false);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDropActive(false);
                  const file = event.dataTransfer.files[0];
                  if (file) {
                    applyLocalFile(file);
                  }
                }}
              >
                <FluentIcon name="documentQueueAdd" size={20} className="fr-dropzone-hero" />
                <span className="fr-dropzone-hint">{he.dropHint}</span>
                <span className="fr-dropzone-actions">
                  <button
                    type="button"
                    className="fr-dropzone-browse"
                    onClick={(event) => {
                      event.stopPropagation();
                      pickFromComputer();
                    }}
                  >
                    <FluentIcon name="attach" size={12} />
                    {he.chooseFromComputer}
                  </button>
                  <button
                    type="button"
                    className="fr-dropzone-browse"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPicked(DESIGN_CLOUD_FILE);
                    }}
                  >
                    <FluentIcon name="cloud" size={12} />
                    {he.chooseFromCloud}
                  </button>
                </span>
              </div>
            )}
            <p className="fr-hint fr-link-quiet">
              {linkFileSavedInOrgLabel(PROVIDER_LABEL[picked?.provider ?? "sharepoint"])}
            </p>

            <fieldset className="fr-field-wrap">
              <legend className="fr-label fr-label-icon">
                <FluentIcon name="globe" />
                {he.linkWhoCanOpen}
              </legend>
              <div className="fr-choice fr-choice-cards">
                <label className={publicBlocked ? "fr-choice-locked" : undefined}>
                  <input
                    type="radio"
                    name="link-access"
                    checked={access === "anyone"}
                    disabled={publicBlocked}
                    onChange={() => {
                      setAccess("anyone");
                    }}
                  />
                  <span className="fr-link-access-card">
                    <FluentIcon name="link" />
                    <span>
                      <span className="fr-link-access-title">{he.linkAccessAnyone}</span>
                      <span className="fr-link-access-desc">{he.linkAccessAnyoneHint}</span>
                    </span>
                    {publicBlocked ? <FluentIcon name="lock" size={12} /> : null}
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="link-access"
                    checked={access === "people"}
                    onChange={() => {
                      setAccess("people");
                    }}
                  />
                  <span className="fr-link-access-card">
                    <FluentIcon name="people" />
                    <span>
                      <span className="fr-link-access-title">{he.linkAccessPeople}</span>
                      <span className="fr-link-access-desc">{he.linkAccessPeopleHint}</span>
                    </span>
                  </span>
                </label>
              </div>
              {publicBlocked ? <p className="fr-hint">{he.linkOrgPolicyIdentified}</p> : null}
            </fieldset>

            <div className={`fr-history-fold${peopleOpen ? " fr-open" : ""}`}>
              <div>
                <div className="fr-field-wrap">
                  <label className="fr-label fr-label-icon" htmlFor="link-people">
                    <FluentIcon name="person" />
                    {he.linkPeopleLabel}
                  </label>
                  <div className="fr-email-box">
                    {emails.map((email) => (
                      <span key={email} className="fr-email-chip">
                        <LtrValue>{email}</LtrValue>
                        <button
                          type="button"
                          className="fr-icon-btn"
                          aria-label={`${he.removeFile} ${email}`}
                          onClick={() => {
                            setEmails(emails.filter((item) => item !== email));
                          }}
                        >
                          <FluentIcon name="dismiss" size={12} />
                        </button>
                      </span>
                    ))}
                    <input
                      id="link-people"
                      className="fr-email-input"
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      placeholder={he.linkPeoplePlaceholder}
                      value={emailDraft}
                      onChange={(event) => {
                        setEmailDraft(event.target.value);
                        if (emailError) {
                          setEmailError(null);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === ",") {
                          event.preventDefault();
                          commitEmails(emailDraft);
                        }
                        if (event.key === "Backspace" && !emailDraft && emails.length > 0) {
                          setEmails(emails.slice(0, -1));
                        }
                      }}
                      onBlur={() => {
                        if (emailDraft.trim()) {
                          commitEmails(emailDraft);
                        }
                      }}
                    />
                  </div>
                  {emailError ? <span className="fr-field-error">{emailError}</span> : null}
                  <span className="fr-hint">{he.linkPeopleHint}</span>
                </div>
              </div>
            </div>

            <fieldset className="fr-field-wrap">
              <legend className="fr-label fr-label-icon">
                <FluentIcon name="clock" />
                {he.linkExpiryLabel}
              </legend>
              <div className="fr-choice">
                {(
                  [
                    ["1d", he.linkExpiryOneDay],
                    ["3d", he.linkExpiryThreeDays],
                    ["7d", he.linkExpirySevenDays],
                    ["custom", he.linkExpiryCustom],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="link-expiry"
                      checked={expiry === value}
                      onChange={() => {
                        setExpiry(value);
                      }}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <div className={`fr-history-fold${customOpen ? " fr-open" : ""}`}>
                <div>
                  <label className="fr-field-wrap" htmlFor="link-expiry-custom">
                    <span className="fr-label fr-label-icon">
                      <FluentIcon name="calendar" />
                      {he.linkExpiryCustomLabel}
                    </span>
                    <input
                      id="link-expiry-custom"
                      type="datetime-local"
                      className="fr-field fr-date"
                      min={datetimeLocalValue(now)}
                      max={datetimeLocalValue(maxExpiresAt)}
                      value={customValue}
                      onChange={(event) => {
                        const next = new Date(event.target.value);
                        if (Number.isNaN(next.getTime())) {
                          setCustomValue(event.target.value);
                          return;
                        }
                        setCustomValue(datetimeLocalValue(clampExpiry(next, now, maxExpiresAt)));
                      }}
                    />
                  </label>
                </div>
              </div>
              {expirySummary ? <p className="fr-hint">{expirySummary}</p> : null}
            </fieldset>
          </div>

          <div className="fr-compose-form-actions">
            <button
              type="button"
              className="fr-btn fr-btn-primary"
              disabled={!canCreate}
              onClick={onCreate}
            >
              {he.linkCreate}
            </button>
            <button type="button" className="fr-btn fr-btn-secondary" onClick={onClose}>
              {he.cancel}
            </button>
          </div>
        </div>
      ) : null}

      {stage === "uploading" ? (
        <div className="fr-compose-send-body fr-link-stage">
          <h2 id="compose-title" className="fr-compose-form-title">
            <FluentIcon name="link" size={18} />
            {he.createExternalLink}
          </h2>
          <div className="fr-link-progress">
            <FluentIcon name={fileKindIcon(picked?.name ?? "")} size={18} />
            <div className="fr-link-progress-meta">
              <FileName name={picked?.name ?? DESIGN_COMPUTER_FILE.name} className="fr-dropzone-name" />
              <div className="fr-progress">
                <span>{he.linkPreparing}</span>
                <div className="fr-progress-bar">
                  <span />
                </div>
              </div>
            </div>
          </div>
          <div className="fr-compose-form-actions">
            <span className="fr-link-action-spacer" />
            <button
              type="button"
              className="fr-btn fr-btn-secondary"
              onClick={() => {
                setStage("form");
              }}
            >
              {he.cancel}
            </button>
          </div>
        </div>
      ) : null}

      {stage === "success" ? (
        <div className="fr-compose-send-body fr-link-stage">
          <h2 id="compose-title" className="fr-compose-form-title">
            <span className="fr-link-success-icon">
              <FluentIcon name="link" size={18} />
              <FluentIcon name="checkmark" size={12} />
            </span>
            {he.linkReadyTitle}
          </h2>
          <div className="fr-link-success">
            <label className="fr-field-wrap" htmlFor="link-ready-url">
              <span className="fr-label">{he.linkUrlLabel}</span>
              <input
                id="link-ready-url"
                className="fr-field"
                dir="ltr"
                readOnly
                value={DESIGN_LINK_URL}
              />
            </label>
            <button type="button" className="fr-btn fr-btn-primary" onClick={() => void copyLink()}>
              <FluentIcon name="copy" />
              {copied ? he.linkCopied : he.linkCopy}
            </button>
            <dl className="fr-link-facts">
              <div>
                <dt>{he.previewFileLabel}</dt>
                <dd>
                  <FileName name={picked?.name ?? DESIGN_COMPUTER_FILE.name} />
                </dd>
              </div>
              <div>
                <dt>{he.linkAccessSummaryLabel}</dt>
                <dd>
                  {access === "people"
                    ? linkAccessPeopleCountLabel(emails.length || 3)
                    : he.linkAccessAnyone}
                </dd>
              </div>
              <div>
                <dt>{he.linkExpiresLabel}</dt>
                <dd>{expirySummary}</dd>
              </div>
              <div>
                <dt>{he.linkStatusLabel}</dt>
                <dd>{he.linkNotDownloaded}</dd>
              </div>
            </dl>
            {openedHint ? <p className="fr-hint">{DESIGN_LINK_URL}</p> : null}
            {revokeOpen ? null : (
            <div className="fr-link-secondary">
              <button type="button" className="fr-btn fr-btn-ghost" onClick={openLink}>
                <FluentIcon name="open" />
                {he.linkOpen}
              </button>
              <button
                type="button"
                className="fr-btn fr-btn-danger-ghost"
                onClick={() => {
                  setRevokeOpen(true);
                }}
              >
                <FluentIcon name="dismiss" />
                {he.linkRevoke}
              </button>
              <button type="button" className="fr-btn fr-btn-ghost" onClick={resetForm}>
                <FluentIcon name="add" />
                {he.linkCreateAnother}
              </button>
            </div>
            )}
          </div>
        </div>
      ) : null}

      {revokeOpen ? (
        <div className="fr-form-drawer fr-link-revoke" role="dialog" aria-labelledby="link-revoke-title">
          <div className="fr-dialog-head">
            <h2 id="link-revoke-title" className="fr-dialog-title">
              <FluentIcon name="delete" size={18} />
              {he.linkRevokeConfirm}
            </h2>
            <button
              type="button"
              className="fr-drawer-back"
              dir="ltr"
              aria-label={he.backToMenu}
              onClick={() => {
                setRevokeOpen(false);
              }}
            >
              <FluentIcon name="chevronLeft" />
              {he.back}
            </button>
          </div>
          <p className="fr-hint">{he.linkRevokeConfirmBody}</p>
          <div className="fr-compose-form-actions">
            <button
              type="button"
              className="fr-btn fr-btn-danger"
              onClick={resetForm}
            >
              {he.linkConfirmRevoke}
            </button>
            <button
              type="button"
              className="fr-btn fr-btn-secondary"
              onClick={() => {
                setRevokeOpen(false);
              }}
            >
              {he.cancel}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
