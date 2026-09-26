// automation.js
// ══════════════════════════════════════════════════════════════════════════════
// AUTOMATION WORKFLOW + CRM — Super Admin → Automation Workflow / Contacts /
// Tasks / Opportunities / Triggers
// ══════════════════════════════════════════════════════════════════════════════
// Everything that used to live in the "AUTOMATION WORKFLOWS" and
// "CRM: Contact / Opportunity / Pipeline" sections of server.js now lives
// here — the workflow engine itself (Workflow/WorkflowRun/PendingStep,
// runWorkflows, the wait-resume poller), plus the CRM building blocks a
// workflow's actions read and write (Contact, Task, Pipeline, Opportunity,
// TrackedLink/"Trigger Links"), plus InternalNotification (created by the
// "Send Internal Notification" action), plus the two small public routes
// that only exist to feed real events INTO workflows (the /l/:code tracked
// link redirect, and /api/inbound/message for the "Customer Replied"
// trigger).
//
// HOW TO WIRE THIS INTO server.js:
//
//   const setupAutomation = require("./automation");
//   const automation = setupAutomation(app, { mongoose, protect, adminOnly, crypto, whatsapp, User, Notification });
//
// Call this AFTER `whatsapp` (setupWhatsApp's return value) and the `User`
// and `Notification` models already exist. Every other place in server.js
// that used to call the bare `runWorkflows(trigger, ctx)` now calls
// `automation.runWorkflows(trigger, ctx)` instead — see server.js's own
// comments at each call site.
//
// ── WHAT CHANGED IN THIS VERSION (vs. the code this was extracted from) ─────
// 1. WHATSAPP NUMBER FORMAT — the "Send WhatsApp Message" action now
//    accepts a Pakistani number in ANY common shape and always sends to the
//    correct one: "+923001234567", "923001234567", "03001234567", or even
//    just "3001234567" (no leading 0, no country code) all resolve to the
//    same 923001234567. See normalizePakWhatsApp() below.
// 2. WAIT STEP — 2 fixes:
//    a) The step now takes hours + minutes + seconds together (three
//       fields, combined), instead of one amount + one unit dropdown.
//    b) THE DUPLICATE-SEND GLITCH: the poller that resumes a workflow after
//       a wait used to `find()` due steps and delete them one at a time
//       inside a loop — if that loop was still running when the next
//       60-second tick fired (or, during a deploy, two server processes
//       briefly overlapped), the same due step could be picked up and run
//       more than once, sending the same message several times. Fixed with
//       an atomic claim (`findOneAndDelete` — MongoDB guarantees only one
//       caller ever gets a given document back from that, even from two
//       processes at once) and a same-process re-entrancy guard, so every
//       wait step now resumes exactly once, however many times you set it.
// 3. NEW: Contact gets an `address` field, and CSV import
//    (POST /api/admin/contacts/import) — Excel opens/saves .csv natively,
//    same convention as the Review Importer elsewhere in this codebase, so
//    "import from Excel or CSV" both mean the same file. Filtering by tag,
//    task, address, or name is on GET /api/admin/contacts via query params.
// 4. NEW: Task — a simple task list (title, description, status, due date,
//    assignee, optionally linked to a Contact), plus a new "update_task"
//    workflow action that lets a workflow move an existing task (picked by
//    name) to a new status when it runs.
// 5. PIPELINE IS NOW MULTIPLE PIPELINES — Opportunity used to have one
//    fixed, global stage list. Now there's a Pipeline model (name + its own
//    ordered stage list) and Opportunities belong to one. A default
//    pipeline (the old 6 stages) is created automatically the first time
//    it's needed, so older workflows that never picked a pipeline keep
//    working unchanged.
// 6. TRACKEDLINK IS NOW "TRIGGER LINKS" — TrackedLink gets a `name` field so
//    links can be created ahead of time from a dedicated Triggers tab
//    (name + destination URL → a stable /l/<code>), not only auto-created
//    from a [[Label|url]] written into a message body (that still works
//    too, unchanged). The "Link Clicked" trigger can now be scoped to one
//    specific saved trigger link instead of firing for every link on the
//    site.
// ══════════════════════════════════════════════════════════════════════════════

const multer = require("multer");

module.exports = function setupAutomation(app, deps) {
  const { mongoose, protect, adminOnly, crypto, whatsapp, User, Notification } = deps;

  // ══════════════════════════════════════════════════════════════════════════
  // SCHEMAS
  // ══════════════════════════════════════════════════════════════════════════

  const WorkflowStepSchema = new mongoose.Schema({
    type: { type: String, enum: ["condition", "action"], required: true },
    actionType: {
      type: String,
      enum: [
        "create_contact", "add_contact_tag", "remove_contact_tag",
        "assign_user", "remove_assigned_user", "add_note", "internal_notification",
        "notify_student", "wait", "send_whatsapp",
        "add_to_pipeline", "update_opportunity_stage", "update_task", "webhook",
      ],
    },
    conditionField:    String,
    conditionOperator: { type: String, enum: ["equals", "not_equals", "contains"] },
    conditionValue:    String,
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
  }, { _id: true });

  // See server.js's own trigger-wiring notes for which of these fire for
  // real vs. need something external wired up — that honesty note applies
  // unchanged; it just now lives in server.js next to the call sites.
  const WORKFLOW_TRIGGERS = [
    "form_submitted", "new_sign_up", "enrollment_created", "payment_received",
    "offer_access_granted", "payment_rejected", "lesson_started", "lesson_completed",
    "category_started", "category_completed", "newsletter_subscribed",
    "opportunity_created", "opportunity_status_changed", "link_clicked",
    "whatsapp_sent", "customer_replied",
  ];

  const WorkflowSchema = new mongoose.Schema({
    name:      { type: String, required: true, trim: true },
    trigger:   { type: String, required: true, enum: WORKFLOW_TRIGGERS },
    published: { type: Boolean, default: false },
    // Optional scoping — lesson_started/completed (courseId/sectionId/
    // lectureId), form_submitted (formSlug), category_started/completed
    // (category), link_clicked (trackedLinkCode). Empty = fires for every
    // event of that trigger, same as leaving it unset always has.
    triggerScope: { type: mongoose.Schema.Types.Mixed, default: {} },
    steps:     { type: [WorkflowStepSchema], default: [] },
    runCount:  { type: Number, default: 0 },
    lastRunAt: Date,
  }, { timestamps: true });
  const Workflow = mongoose.model("Workflow", WorkflowSchema);

  const WorkflowRunSchema = new mongoose.Schema({
    workflow:  { type: mongoose.Schema.Types.ObjectId, ref: "Workflow", required: true },
    trigger:   String,
    summary:   String,
    status:    { type: String, enum: ["success", "partial", "failed", "waiting"], default: "success" },
    log:       { type: [String], default: [] },
  }, { timestamps: true });
  const WorkflowRun = mongoose.model("WorkflowRun", WorkflowRunSchema);

  const PendingStepSchema = new mongoose.Schema({
    workflow:   { type: mongoose.Schema.Types.ObjectId, ref: "Workflow", required: true },
    run:        { type: mongoose.Schema.Types.ObjectId, ref: "WorkflowRun", required: true },
    stepIndex:  { type: Number, required: true },
    context:    { type: mongoose.Schema.Types.Mixed, default: {} },
    runAt:      { type: Date, required: true },
  }, { timestamps: true });
  const PendingStep = mongoose.model("PendingStep", PendingStepSchema);

  // Internal (admin-facing) notification — created by the "Send Internal
  // Notification" action. Distinct from the student-facing Notification
  // model (which stays in server.js — it's used well beyond automation).
  const InternalNotificationSchema = new mongoose.Schema({
    message: { type: String, required: true },
    read:    { type: Boolean, default: false },
  }, { timestamps: true });
  const InternalNotification = mongoose.model("InternalNotification", InternalNotificationSchema);

  // ── Contact ──────────────────────────────────────────────────────────────
  const ContactSchema = new mongoose.Schema({
    name:  { type: String, default: "" },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, default: "" },
    address: { type: String, default: "" },
    source: { type: String, default: "" },
    tags:  { type: [String], default: [] },
    notes: { type: [{ text: String, createdAt: { type: Date, default: Date.now } }], default: [] },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    studentId:  { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  }, { timestamps: true });
  ContactSchema.index({ email: 1 }, { unique: true, sparse: true });
  const Contact = mongoose.model("Contact", ContactSchema);

  // ── Task ─────────────────────────────────────────────────────────────────
  const TaskSchema = new mongoose.Schema({
    title:       { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    status:      { type: String, enum: ["todo", "in_progress", "done"], default: "todo" },
    dueDate:     { type: Date, default: null },
    assignedTo:  { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    contact:     { type: mongoose.Schema.Types.ObjectId, ref: "Contact", default: null },
  }, { timestamps: true });
  const Task = mongoose.model("Task", TaskSchema);

  // ── Pipeline (multiple, each with its own stage list) + Opportunity ────────
  const DEFAULT_PIPELINE_STAGES = ["New Lead", "Contacted", "Qualified", "Payment Pending", "Customer", "Lost"];
  const PipelineSchema = new mongoose.Schema({
    name:      { type: String, required: true, trim: true },
    stages:    { type: [String], default: DEFAULT_PIPELINE_STAGES },
    isDefault: { type: Boolean, default: false },
  }, { timestamps: true });
  const Pipeline = mongoose.model("Pipeline", PipelineSchema);

  async function getDefaultPipeline() {
    let pipeline = await Pipeline.findOne({ isDefault: true });
    if (!pipeline) {
      // Upsert-safe even if two requests race to create it at the same time.
      pipeline = await Pipeline.findOneAndUpdate(
        { isDefault: true },
        { $setOnInsert: { name: "Default Pipeline", stages: DEFAULT_PIPELINE_STAGES, isDefault: true } },
        { new: true, upsert: true }
      );
    }
    return pipeline;
  }

  const OpportunitySchema = new mongoose.Schema({
    pipeline: { type: mongoose.Schema.Types.ObjectId, ref: "Pipeline", required: true },
    contact:  { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
    title:    { type: String, default: "" },
    value:    { type: Number, default: 0 },
    stage:    { type: String, default: "" },
    status:   { type: String, enum: ["open", "won", "lost"], default: "open" },
  }, { timestamps: true });
  const Opportunity = mongoose.model("Opportunity", OpportunitySchema);

  // ── Trigger Links (a named, stable TrackedLink you create ahead of time) ──
  // A message body can also still write [[Label|https://example.com]]
  // inline — rewriteTrackedLinks() below creates an unnamed one of these on
  // the fly for that, exactly as before.
  const TrackedLinkSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    name: { type: String, default: "" }, // set when created from the Triggers tab
    url:  { type: String, required: true },
    contactEmail: String,
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: "Workflow" },
    clicks: { type: Number, default: 0 },
  }, { timestamps: true });
  const TrackedLink = mongoose.model("TrackedLink", TrackedLinkSchema);

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  // Creates or updates a Contact directly from a public form submission —
  // independent of any workflow's "Create Contact" action, so every real
  // form submission (enrollment, package inquiry, contact form) shows up on
  // the Contacts tab even before an admin has built a workflow for it.
  async function upsertContactFromForm({ name, email, phone, source }) {
    const cleanEmail = (email || "").trim().toLowerCase();
    const cleanPhone = (phone || "").trim();
    if (!cleanEmail && !cleanPhone) return null;
    try {
      if (cleanEmail) {
        return await Contact.findOneAndUpdate(
          { email: cleanEmail },
          {
            $set: { ...(name ? { name } : {}), ...(cleanPhone ? { phone: cleanPhone } : {}) },
            $setOnInsert: { source: source || "Form" },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }
      return await Contact.create({ name: name || "", phone: cleanPhone, source: source || "Form" });
    } catch (err) {
      console.error("[Automation] upsertContactFromForm failed:", err.message);
      return null;
    }
  }

  /** Replaces {{field}} in a string with the matching value from the context object. */
  function interpolate(str, ctx) {
    if (typeof str !== "string") return str;
    return str.replace(/\{\{(\w+)\}\}/g, (_, key) => (ctx[key] != null ? String(ctx[key]) : ""));
  }

  // A message body can carry `[[Label|https://example.com]]` — rewritten here
  // into a real tracked link (/l/<code>) so a click can be logged and fire the
  // link_clicked trigger. Used by send_whatsapp.
  async function rewriteTrackedLinks(text, ctx, workflowId) {
    const linkPattern = /\[\[([^\|\]]+)\|([^\]]+)\]\]/g;
    const matches = [...text.matchAll(linkPattern)];
    let result = text;
    for (const m of matches) {
      const [full, label, url] = m;
      const code = crypto.randomBytes(5).toString("hex");
      await TrackedLink.create({ code, url: url.trim(), contactEmail: ctx.studentEmail || ctx.email || "", workflow: workflowId });
      const trackedUrl = `${process.env.PUBLIC_BASE_URL || ""}/l/${code}`;
      result = result.replace(full, `${label.trim()}: ${trackedUrl}`);
    }
    return result;
  }

  // NEW: normalizes any common way of writing a Pakistani WhatsApp number
  // down to the one canonical shape WhatsApp itself needs (country code,
  // no leading zero, digits only) — so "Send WhatsApp Message" reaches the
  // number regardless of which format it was typed/stored in:
  //   +923001234567 / 923001234567 / 03001234567 / 3001234567  →  923001234567
  function normalizePakWhatsApp(raw) {
    let d = String(raw || "").trim().replace(/[^\d]/g, "");
    if (!d) return "";
    if (d.startsWith("0092")) d = d.slice(2);      // 0092… → 92…
    if (d.startsWith("92")) return d;               // already correct
    if (d.startsWith("0")) return "92" + d.slice(1); // 03XXXXXXXXX → 923XXXXXXXX
    if (d.length === 10 && d.startsWith("3")) return "92" + d; // 3XXXXXXXXX → 923XXXXXXXX
    return d; // not a recognizable Pakistani shape — leave as-is (e.g. another country's number)
  }

  function conditionMatches(step, ctx) {
    const actual = ctx[step.conditionField];
    const expected = step.conditionValue;
    switch (step.conditionOperator) {
      case "not_equals": return String(actual ?? "") !== String(expected ?? "");
      case "contains":    return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
      default:            return String(actual ?? "") === String(expected ?? ""); // "equals"
    }
  }

  const WAIT_UNIT_MS = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000, years: 31536000000 };

  // NEW: the Wait step now takes hours + minutes + seconds together. Old
  // workflows saved before this change (amount + unit) still work exactly
  // as they did.
  function waitMs(p) {
    const h = Number(p.hours) || 0, m = Number(p.minutes) || 0, s = Number(p.seconds) || 0;
    if (h || m || s) return h * WAIT_UNIT_MS.hours + m * WAIT_UNIT_MS.minutes + s * WAIT_UNIT_MS.seconds;
    const amount = Number(p.amount) || 0;
    const unit = p.unit || "minutes";
    return amount * (WAIT_UNIT_MS[unit] || WAIT_UNIT_MS.minutes);
  }

  /** Runs one action step against the given context. Throws on hard failure; log lines describe what happened either way. */
  async function runAction(step, ctx, log, workflowId) {
    const p = step.params || {};

    switch (step.actionType) {
      case "create_contact": {
        const email = interpolate(p.email || "{{studentEmail}}", ctx) || interpolate(p.email || "{{email}}", ctx);
        if (!email) { log.push("create_contact skipped — no email in context"); return; }
        const contact = await Contact.findOneAndUpdate(
          { email },
          {
            $setOnInsert: {
              email, name: interpolate(p.name || "{{studentName}}", ctx) || interpolate("{{name}}", ctx) || "",
              phone: ctx.whatsapp || "", address: "", source: p.source || `Workflow: ${ctx.__workflowName || ""}`,
              studentId: ctx.studentId || null,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        log.push(`Contact ensured for ${email}`);
        ctx.contactId = contact._id;
        return;
      }
      case "add_contact_tag":
      case "remove_contact_tag": {
        const email = ctx.studentEmail || ctx.email;
        if (!email || !p.tag) { log.push(`${step.actionType} skipped — no contact email/tag`); return; }
        const op = step.actionType === "add_contact_tag" ? { $addToSet: { tags: p.tag } } : { $pull: { tags: p.tag } };
        await Contact.findOneAndUpdate({ email }, op);
        log.push(`${step.actionType === "add_contact_tag" ? "Added" : "Removed"} tag "${p.tag}" on contact ${email}`);
        return;
      }
      case "assign_user":
      case "remove_assigned_user": {
        const email = ctx.studentEmail || ctx.email;
        if (!email) { log.push(`${step.actionType} skipped — no contact email`); return; }
        const assignedTo = step.actionType === "assign_user" ? (p.userId || null) : null;
        await Contact.findOneAndUpdate({ email }, { assignedTo });
        log.push(step.actionType === "assign_user" ? `Assigned contact ${email} to user ${p.userId}` : `Cleared assignment on contact ${email}`);
        return;
      }
      case "add_note": {
        const email = ctx.studentEmail || ctx.email;
        if (!email || !p.text) { log.push("add_note skipped — no contact email/text"); return; }
        await Contact.findOneAndUpdate({ email }, { $push: { notes: { text: interpolate(p.text, ctx) } } });
        log.push(`Note added to contact ${email}`);
        return;
      }
      case "internal_notification": {
        await InternalNotification.create({ message: interpolate(p.message || "", ctx) });
        log.push("Internal notification created for the admin team");
        return;
      }
      case "notify_student": {
        if (!ctx.studentId) { log.push("notify_student skipped — no student in context"); return; }
        await Notification.create({ student: ctx.studentId, title: interpolate(p.title || "", ctx), message: interpolate(p.message || "", ctx) });
        log.push(`Notification created for ${ctx.studentName || ctx.studentId}`);
        return;
      }
      case "update_task": {
        if (!p.taskId) { log.push("update_task skipped — no task selected"); return; }
        const task = await Task.findByIdAndUpdate(p.taskId, { status: p.status || "done" }, { new: true });
        if (!task) { log.push("update_task skipped — the selected task no longer exists"); return; }
        log.push(`Task "${task.title}" set to "${task.status}"`);
        return;
      }
      case "send_whatsapp": {
        // Prefers a self-hosted session (Baileys) if selected — falls back
        // to the single Meta Cloud API connection (Settings → WhatsApp) if
        // none is chosen, so a workflow built before self-hosted numbers
        // existed keeps working unchanged.
        let text = interpolate(p.message || "", ctx);
        text = await rewriteTrackedLinks(text, ctx, workflowId);

        const rawTo = interpolate(p.to || "{{whatsapp}}", ctx) || interpolate("{{studentPhone}}", ctx);
        const to = normalizePakWhatsApp(rawTo);
        if (!to) { log.push("send_whatsapp skipped — no phone number in context"); return; }

        if (p.selfHostedSessionId) {
          const session = await whatsapp.WhatsAppSelfSession.findById(p.selfHostedSessionId).catch(() => null);
          if (!session) { log.push("send_whatsapp skipped — the selected self-hosted number no longer exists"); return; }
          if (session.status !== "connected") { log.push(`send_whatsapp skipped — "${session.label}" isn't connected (scan its QR in Super Admin → WhatsApp → Self-Hosted Server)`); return; }
          try {
            const waMessageId = await whatsapp.sendSelfHostedMessage(session.sessionId, to, text);
            await whatsapp.logWhatsAppMessage({ instanceId: session.sessionId, direction: "outgoing", number: to, message: text, status: "sent", source: "workflow", waMessageId });
          } catch (err) {
            await whatsapp.logWhatsAppMessage({ instanceId: session.sessionId, direction: "outgoing", number: to, message: text, status: "failed", source: "workflow" });
            throw err;
          }
          log.push(`WhatsApp message sent to +${to} via "${session.label}" (self-hosted)`);
          runWorkflows("whatsapp_sent", { ...ctx, to, __summary: `WhatsApp to +${to} via ${session.label}` });
          return;
        }

        // Fallback: the original single-number Meta Cloud API path.
        if (!(await whatsapp.whatsappConfigured())) { log.push("send_whatsapp skipped — no WhatsApp number selected, and no Meta Cloud API connected either"); return; }
        await whatsapp.sendWhatsAppRaw({ to, text });
        log.push(`WhatsApp message sent to +${to}`);
        runWorkflows("whatsapp_sent", { ...ctx, to, __summary: `WhatsApp to +${to}` });
        return;
      }
      case "add_to_pipeline": {
        const email = ctx.studentEmail || ctx.email;
        if (!email) { log.push("add_to_pipeline skipped — no contact email"); return; }
        let contact = await Contact.findOne({ email });
        if (!contact) contact = await Contact.create({ email, name: ctx.studentName || ctx.name || "", studentId: ctx.studentId || null, source: `Workflow: ${ctx.__workflowName || ""}` });
        const pipeline = p.pipelineId ? await Pipeline.findById(p.pipelineId) : await getDefaultPipeline();
        if (!pipeline) { log.push("add_to_pipeline skipped — the selected pipeline no longer exists"); return; }
        const stage = p.stage && pipeline.stages.includes(p.stage) ? p.stage : pipeline.stages[0];
        let opp = await Opportunity.findOne({ contact: contact._id, pipeline: pipeline._id, status: "open" });
        const isNew = !opp;
        if (!opp) opp = new Opportunity({ contact: contact._id, pipeline: pipeline._id, title: p.title || ctx.courseTitle || "Opportunity", value: Number(p.value) || ctx.amount || 0, stage });
        else opp.stage = stage;
        await opp.save();
        log.push(`${isNew ? "Created" : "Updated"} opportunity for ${email} in "${pipeline.name}" → stage "${stage}"`);
        runWorkflows(isNew ? "opportunity_created" : "opportunity_status_changed", { ...ctx, opportunityId: opp._id, stage, __summary: `${email} → ${stage}` });
        return;
      }
      case "update_opportunity_stage": {
        const email = ctx.studentEmail || ctx.email;
        if (!email || !p.stage) { log.push("update_opportunity_stage skipped — no contact email/stage"); return; }
        const contact = await Contact.findOne({ email });
        if (!contact) { log.push(`update_opportunity_stage skipped — no contact found for ${email}`); return; }
        const query = { contact: contact._id, status: "open" };
        if (p.pipelineId) query.pipeline = p.pipelineId;
        const opp = await Opportunity.findOneAndUpdate(query, { stage: p.stage }, { new: true });
        if (!opp) { log.push(`update_opportunity_stage skipped — no open opportunity for ${email}`); return; }
        log.push(`Opportunity stage for ${email} → "${p.stage}"`);
        runWorkflows("opportunity_status_changed", { ...ctx, opportunityId: opp._id, stage: p.stage, __summary: `${email} → ${p.stage}` });
        return;
      }
      case "webhook": {
        if (!p.url) { log.push("webhook skipped — no URL configured"); return; }
        const resp = await fetch(p.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trigger: ctx.__trigger, ...ctx }),
        });
        log.push(`Webhook POSTed to ${p.url} (HTTP ${resp.status})`);
        return;
      }
      default:
        log.push(`Unknown action type "${step.actionType}" — skipped`);
    }
  }

  /** Executes a workflow's steps starting at `fromIndex`, pausing (via PendingStep) on a wait step. */
  async function executeWorkflowSteps(workflow, run, ctx, fromIndex) {
    const log = run.log || [];
    ctx.__workflowName = workflow.name;
    for (let i = fromIndex; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      if (step.type === "condition") {
        if (!conditionMatches(step, ctx)) {
          log.push(`Condition "${step.conditionField} ${step.conditionOperator} ${step.conditionValue}" not met — stopped here`);
          run.status = "partial";
          run.log = log;
          await run.save();
          return;
        }
        log.push(`Condition "${step.conditionField} ${step.conditionOperator} ${step.conditionValue}" matched`);
        continue;
      }
      if (step.actionType === "wait") {
        const ms = waitMs(step.params || {});
        const runAt = new Date(Date.now() + ms);
        await PendingStep.create({ workflow: workflow._id, run: run._id, stepIndex: i + 1, context: ctx, runAt });
        log.push(`Waiting — resumes at ${runAt.toISOString()}`);
        run.status = "waiting";
        run.log = log;
        await run.save();
        return;
      }
      try {
        await runAction(step, ctx, log, workflow._id);
      } catch (err) {
        log.push(`Action "${step.actionType}" failed: ${err.message}`);
        run.status = "failed";
        run.log = log;
        await run.save();
        return;
      }
    }
    run.status = run.status === "waiting" ? "success" : (run.status || "success");
    run.log = log;
    await run.save();
  }

  /** Call this from anywhere a real event happens — fires every published workflow listening for that trigger. Never throws: a broken workflow must not break the request that triggered it. */
  function matchesTriggerScope(workflow, context) {
    const scope = workflow.triggerScope || {};
    if (scope.lectureId && String(context.lectureId || "") !== String(scope.lectureId)) return false;
    if (scope.courseId && String(context.courseId || "") !== String(scope.courseId)) return false;
    if (scope.formSlug && String(context.formSlug || "") !== String(scope.formSlug)) return false;
    if (scope.category && String(context.category || "") !== String(scope.category)) return false;
    if (scope.trackedLinkCode && String(context.trackedLinkCode || "") !== String(scope.trackedLinkCode)) return false;
    return true;
  }

  async function runWorkflows(trigger, context) {
    try {
      const workflows = await Workflow.find({ trigger, published: true });
      for (const workflow of workflows) {
        if (!matchesTriggerScope(workflow, context)) continue;
        const ctx = { ...context, __trigger: trigger };
        const run = await WorkflowRun.create({ workflow: workflow._id, trigger, summary: context.__summary || "", status: "success", log: [] });
        workflow.runCount = (workflow.runCount || 0) + 1;
        workflow.lastRunAt = new Date();
        await workflow.save();
        await executeWorkflowSteps(workflow, run, ctx, 0);
      }
    } catch (err) {
      console.error("[Automation] runWorkflows error:", err.message);
    }
  }

  // ── Wait-resume poller ──────────────────────────────────────────────────
  // FIX (duplicate-send glitch): each due PendingStep is claimed with
  // findOneAndDelete — an ATOMIC operation, so even if two server processes
  // are briefly running at once (e.g. during a Render redeploy) only one of
  // them can ever get a given pending step back; the other gets null and
  // moves on. `pollerBusy` additionally stops a slow tick (many things due
  // at once) from overlapping the next scheduled tick in this same process.
  // Together these guarantee a resumed step runs exactly once.
  let pollerBusy = false;
  setInterval(async () => {
    if (pollerBusy) return;
    pollerBusy = true;
    try {
      for (let i = 0; i < 50; i++) {
        const pending = await PendingStep.findOneAndDelete({ runAt: { $lte: new Date() } }).sort("runAt");
        if (!pending) break;
        try {
          const workflow = await Workflow.findById(pending.workflow);
          const run = await WorkflowRun.findById(pending.run);
          if (!workflow || !run || !workflow.published) continue;
          run.status = "success";
          await executeWorkflowSteps(workflow, run, pending.context, pending.stepIndex);
        } catch (innerErr) {
          console.error("[Automation] resume error:", innerErr.message);
        }
      }
    } catch (err) {
      console.error("[Automation] poller error:", err.message);
    } finally {
      pollerBusy = false;
    }
  }, 10 * 1000); // tightened from 30s → 10s so a scheduled wait resumes closer to on time

  // ══════════════════════════════════════════════════════════════════════════
  // ROUTES — Automation Workflow
  // ══════════════════════════════════════════════════════════════════════════

  app.get("/api/admin/workflows/meta", protect, adminOnly, async (req, res) => {
    const pipelines = await Pipeline.find({}).sort("name");
    res.json({
      triggers: WORKFLOW_TRIGGERS,
      actionTypes: [
        "create_contact", "add_contact_tag", "remove_contact_tag",
        "assign_user", "remove_assigned_user", "add_note", "internal_notification",
        "notify_student", "wait", "send_whatsapp",
        "add_to_pipeline", "update_opportunity_stage", "update_task", "webhook",
      ],
      whatsappConfigured: await whatsapp.whatsappConfigured(),
      pipelines: pipelines.map((p) => ({ _id: p._id, name: p.name, stages: p.stages, isDefault: p.isDefault })),
    });
  });

  app.get("/api/admin/workflows", protect, adminOnly, async (req, res) => {
    try { res.json(await Workflow.find({}).sort("-createdAt").lean()); }
    catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get("/api/admin/workflows/:id", protect, adminOnly, async (req, res) => {
    try {
      const workflow = await Workflow.findById(req.params.id);
      if (!workflow) return res.status(404).json({ message: "Workflow not found" });
      res.json(workflow);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post("/api/admin/workflows", protect, adminOnly, async (req, res) => {
    try {
      const { name, trigger, steps, published, triggerScope } = req.body || {};
      if (!name?.trim()) return res.status(400).json({ message: "Name is required" });
      if (!WORKFLOW_TRIGGERS.includes(trigger)) return res.status(400).json({ message: "Invalid trigger" });
      const workflow = await Workflow.create({
        name: name.trim(), trigger, steps: Array.isArray(steps) ? steps : [], published: published === true,
        triggerScope: triggerScope && typeof triggerScope === "object" ? triggerScope : {},
      });
      res.status(201).json(workflow);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.put("/api/admin/workflows/:id", protect, adminOnly, async (req, res) => {
    try {
      const { name, trigger, steps, published, triggerScope } = req.body || {};
      const update = {};
      if (name !== undefined)    update.name = name.trim();
      if (trigger !== undefined) {
        if (!WORKFLOW_TRIGGERS.includes(trigger)) return res.status(400).json({ message: "Invalid trigger" });
        update.trigger = trigger;
      }
      if (steps !== undefined)     update.steps = steps;
      if (published !== undefined) update.published = published;
      if (triggerScope !== undefined) update.triggerScope = triggerScope && typeof triggerScope === "object" ? triggerScope : {};
      const workflow = await Workflow.findByIdAndUpdate(req.params.id, update, { new: true });
      if (!workflow) return res.status(404).json({ message: "Workflow not found" });
      res.json(workflow);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.delete("/api/admin/workflows/:id", protect, adminOnly, async (req, res) => {
    try {
      const workflow = await Workflow.findByIdAndDelete(req.params.id);
      if (!workflow) return res.status(404).json({ message: "Workflow not found" });
      await PendingStep.deleteMany({ workflow: workflow._id });
      res.json({ deleted: true });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get("/api/admin/workflows/:id/runs", protect, adminOnly, async (req, res) => {
    try { res.json(await WorkflowRun.find({ workflow: req.params.id }).sort("-createdAt").limit(50)); }
    catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post("/api/admin/workflows/:id/test", protect, adminOnly, async (req, res) => {
    try {
      const workflow = await Workflow.findById(req.params.id);
      if (!workflow) return res.status(404).json({ message: "Workflow not found" });
      const testCtx = {
        studentId: req.user._id, studentName: req.user.name, studentEmail: req.user.email,
        courseId: "", courseTitle: "Sample Course", amount: 0, lectureId: "", reason: "Sample reason",
        name: req.user.name, email: req.user.email, message: "Sample message", category: "Sample Category",
        whatsapp: req.user.phone || "",
        __trigger: workflow.trigger, __summary: `Test run by ${req.user.name}`,
      };
      const run = await WorkflowRun.create({ workflow: workflow._id, trigger: workflow.trigger, summary: `Test run by ${req.user.name}`, status: "success", log: [] });
      workflow.runCount = (workflow.runCount || 0) + 1;
      workflow.lastRunAt = new Date();
      await workflow.save();
      await executeWorkflowSteps(workflow, run, testCtx, 0);
      res.json(await WorkflowRun.findById(run._id));
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // People an admin can assign a contact/task to.
  app.get("/api/admin/assignable-users", protect, adminOnly, async (req, res) => {
    try { res.json(await User.find({ role: { $in: ["admin", "instructor"] } }).select("name email role")); }
    catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ROUTES — Contacts
  // ══════════════════════════════════════════════════════════════════════════

  // Filters: ?name= ?address= (substring, case-insensitive), ?tag= (exact
  // tag), ?task= (substring match against a linked task's title).
  app.get("/api/admin/contacts", protect, adminOnly, async (req, res) => {
    try {
      const { name, address, tag, task } = req.query;
      const query = {};
      if (name) query.name = { $regex: name, $options: "i" };
      if (address) query.address = { $regex: address, $options: "i" };
      if (tag) query.tags = tag;
      if (task) {
        const taskDocs = await Task.find({ title: { $regex: task, $options: "i" }, contact: { $ne: null } }).select("contact");
        query._id = { $in: taskDocs.map((t) => t.contact) };
      }
      res.json(await Contact.find(query).populate("assignedTo", "name email").sort("-createdAt").lean());
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get("/api/admin/contacts/export.csv", protect, adminOnly, async (req, res) => {
    try {
      const contacts = await Contact.find({}).sort("-createdAt");
      const rows = [["Name", "Email", "Phone", "Address", "Tags", "Source", "Created"]];
      for (const c of contacts) rows.push([c.name, c.email, c.phone, c.address, (c.tags || []).join("; "), c.source, c.createdAt.toISOString()]);
      const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=contacts.csv");
      res.send(csv);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // Small hand-written CSV parser — zero dependencies (same approach as the
  // Review Importer). Excel opens/saves .csv files natively, so "Excel or
  // CSV" both mean this one format.
  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    const pushField = () => { row.push(field); field = ""; };
    const pushRow = () => { pushField(); rows.push(row); row = []; };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i], next = text[i + 1];
      if (inQuotes) {
        if (ch === '"' && next === '"') { field += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { field += ch; }
      } else if (ch === '"') { inQuotes = true; }
      else if (ch === ",") { pushField(); }
      else if (ch === "\n") { pushRow(); }
      else if (ch === "\r") { /* skip — \r\n handled by the following \n */ }
      else { field += ch; }
    }
    if (field !== "" || row.length > 0) pushRow();
    const filtered = rows.filter((r) => r.some((c) => String(c).trim() !== ""));
    if (filtered.length === 0) return [];
    const headers = filtered[0].map((h) => h.trim());
    return filtered.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i] ?? ""; });
      return obj;
    });
  }

  const csvMulter = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_, file, cb) => {
      const ok = ["text/csv", "application/csv"].includes(file.mimetype) || /\.csv$/i.test(file.originalname || "");
      ok ? cb(null, true) : cb(new Error("Only CSV files are allowed — from Excel, use File → Save As → CSV"));
    },
  });

  app.post("/api/admin/contacts/import", protect, adminOnly, csvMulter.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      let rows;
      try { rows = parseCsv(req.file.buffer.toString("utf8")); }
      catch { return res.status(400).json({ message: "Couldn't read that file — make sure it's a valid CSV." }); }

      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
      const getCell = (row, ...aliases) => {
        const keys = Object.keys(row);
        for (const alias of aliases) {
          const key = keys.find((k) => norm(k) === norm(alias));
          if (key !== undefined) return row[key];
        }
        return "";
      };

      let imported = 0, skipped = 0;
      const errors = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const lineNo = i + 2;
        const name = String(getCell(row, "Name")).trim();
        const email = String(getCell(row, "Email")).trim().toLowerCase();
        const phone = String(getCell(row, "Phone")).trim();
        const address = String(getCell(row, "Address")).trim();
        const tags = String(getCell(row, "Tags")).split(";").map((t) => t.trim()).filter(Boolean);
        if (!name && !email && !phone) { skipped++; errors.push(`Row ${lineNo}: no name, email, or phone — skipped`); continue; }
        try {
          if (email) {
            await Contact.findOneAndUpdate(
              { email },
              { $set: { name: name || undefined, phone: phone || undefined, address: address || undefined }, $addToSet: { tags: { $each: tags } }, $setOnInsert: { source: "CSV Import" } },
              { upsert: true, setDefaultsOnInsert: true }
            );
          } else {
            await Contact.create({ name, phone, address, tags, source: "CSV Import" });
          }
          imported++;
        } catch (err) { skipped++; errors.push(`Row ${lineNo}: ${err.message}`); }
      }
      res.json({ imported, skipped, errors: errors.slice(0, 20) });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.patch("/api/admin/contacts/:id/assign", protect, adminOnly, async (req, res) => {
    try {
      const { userId } = req.body || {};
      const contact = await Contact.findByIdAndUpdate(req.params.id, { assignedTo: userId || null }, { new: true }).populate("assignedTo", "name email");
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      res.json(contact);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post("/api/admin/contacts/:id/notes", protect, adminOnly, async (req, res) => {
    try {
      const { text } = req.body || {};
      if (!text?.trim()) return res.status(400).json({ message: "Note text is required" });
      const contact = await Contact.findByIdAndUpdate(req.params.id, { $push: { notes: { text: text.trim() } } }, { new: true });
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      res.json(contact);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.patch("/api/admin/contacts/:id", protect, adminOnly, async (req, res) => {
    try {
      const allowed = ["name", "email", "phone", "address"];
      const update = {};
      for (const key of allowed) if (req.body?.[key] !== undefined) update[key] = req.body[key];
      const contact = await Contact.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      res.json(contact);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ROUTES — Tasks
  // ══════════════════════════════════════════════════════════════════════════

  app.get("/api/admin/tasks", protect, adminOnly, async (req, res) => {
    try {
      const { status, contactId } = req.query;
      const query = {};
      if (status) query.status = status;
      if (contactId) query.contact = contactId;
      res.json(await Task.find(query).populate("assignedTo", "name email").populate("contact", "name email").sort("-createdAt").lean());
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post("/api/admin/tasks", protect, adminOnly, async (req, res) => {
    try {
      const { title, description, status, dueDate, assignedTo, contact } = req.body || {};
      if (!title?.trim()) return res.status(400).json({ message: "Title is required" });
      const task = await Task.create({
        title: title.trim(), description: description || "", status: ["todo", "in_progress", "done"].includes(status) ? status : "todo",
        dueDate: dueDate || null, assignedTo: assignedTo || null, contact: contact || null,
      });
      res.status(201).json(await task.populate([{ path: "assignedTo", select: "name email" }, { path: "contact", select: "name email" }]));
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.put("/api/admin/tasks/:id", protect, adminOnly, async (req, res) => {
    try {
      const { title, description, status, dueDate, assignedTo, contact } = req.body || {};
      const update = {};
      if (title !== undefined) update.title = title.trim();
      if (description !== undefined) update.description = description;
      if (status !== undefined) update.status = status;
      if (dueDate !== undefined) update.dueDate = dueDate || null;
      if (assignedTo !== undefined) update.assignedTo = assignedTo || null;
      if (contact !== undefined) update.contact = contact || null;
      const task = await Task.findByIdAndUpdate(req.params.id, update, { new: true })
        .populate("assignedTo", "name email").populate("contact", "name email");
      if (!task) return res.status(404).json({ message: "Task not found" });
      res.json(task);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.delete("/api/admin/tasks/:id", protect, adminOnly, async (req, res) => {
    try {
      const task = await Task.findByIdAndDelete(req.params.id);
      if (!task) return res.status(404).json({ message: "Task not found" });
      res.json({ deleted: true });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ROUTES — Pipelines + Opportunities
  // ══════════════════════════════════════════════════════════════════════════

  app.get("/api/admin/pipelines", protect, adminOnly, async (req, res) => {
    try {
      await getDefaultPipeline(); // make sure at least one exists
      res.json(await Pipeline.find({}).sort("name").lean());
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post("/api/admin/pipelines", protect, adminOnly, async (req, res) => {
    try {
      const { name, stages } = req.body || {};
      if (!name?.trim()) return res.status(400).json({ message: "Name is required" });
      const cleanStages = Array.isArray(stages) ? stages.map((s) => String(s).trim()).filter(Boolean) : [];
      const pipeline = await Pipeline.create({ name: name.trim(), stages: cleanStages.length ? cleanStages : DEFAULT_PIPELINE_STAGES });
      res.status(201).json(pipeline);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.put("/api/admin/pipelines/:id", protect, adminOnly, async (req, res) => {
    try {
      const { name, stages } = req.body || {};
      const update = {};
      if (name !== undefined) update.name = name.trim();
      if (stages !== undefined) update.stages = (Array.isArray(stages) ? stages : []).map((s) => String(s).trim()).filter(Boolean);
      const pipeline = await Pipeline.findByIdAndUpdate(req.params.id, update, { new: true });
      if (!pipeline) return res.status(404).json({ message: "Pipeline not found" });
      res.json(pipeline);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.delete("/api/admin/pipelines/:id", protect, adminOnly, async (req, res) => {
    try {
      const pipeline = await Pipeline.findById(req.params.id);
      if (!pipeline) return res.status(404).json({ message: "Pipeline not found" });
      if (pipeline.isDefault) return res.status(400).json({ message: "The default pipeline can't be deleted." });
      const inUse = await Opportunity.countDocuments({ pipeline: pipeline._id });
      if (inUse > 0) return res.status(400).json({ message: `This pipeline has ${inUse} opportunit${inUse === 1 ? "y" : "ies"} in it — move or delete those first.` });
      await Pipeline.findByIdAndDelete(req.params.id);
      res.json({ deleted: true });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get("/api/admin/opportunities", protect, adminOnly, async (req, res) => {
    try {
      const query = {};
      if (req.query.pipelineId) query.pipeline = req.query.pipelineId;
      res.json(await Opportunity.find(query).populate("contact").populate("pipeline", "name stages").sort("-createdAt").lean());
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post("/api/admin/opportunities", protect, adminOnly, async (req, res) => {
    try {
      const { contactId, pipelineId, title, value, stage } = req.body || {};
      if (!contactId) return res.status(400).json({ message: "A contact is required" });
      const pipeline = pipelineId ? await Pipeline.findById(pipelineId) : await getDefaultPipeline();
      if (!pipeline) return res.status(404).json({ message: "Pipeline not found" });
      const opp = await Opportunity.create({
        contact: contactId, pipeline: pipeline._id, title: title || "", value: Number(value) || 0,
        stage: stage && pipeline.stages.includes(stage) ? stage : pipeline.stages[0],
      });
      res.status(201).json(await opp.populate([{ path: "contact" }, { path: "pipeline", select: "name stages" }]));
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get("/api/admin/opportunities/export.csv", protect, adminOnly, async (req, res) => {
    try {
      const opps = await Opportunity.find({}).populate("contact").populate("pipeline", "name").sort("-createdAt");
      const rows = [["Pipeline", "Contact", "Email", "Title", "Value", "Stage", "Status", "Created"]];
      for (const o of opps) rows.push([o.pipeline?.name, o.contact?.name, o.contact?.email, o.title, o.value, o.stage, o.status, o.createdAt.toISOString()]);
      const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=opportunities.csv");
      res.send(csv);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // Drag-and-drop card move (also used by a plain <select> fallback) —
  // fires opportunity_status_changed, same as a workflow doing it.
  app.patch("/api/admin/opportunities/:id/stage", protect, adminOnly, async (req, res) => {
    try {
      const { stage } = req.body || {};
      if (!stage) return res.status(400).json({ message: "stage is required" });
      const opp = await Opportunity.findByIdAndUpdate(req.params.id, { stage }, { new: true }).populate("contact").populate("pipeline", "name stages");
      if (!opp) return res.status(404).json({ message: "Opportunity not found" });
      runWorkflows("opportunity_status_changed", {
        studentEmail: opp.contact?.email, studentName: opp.contact?.name, stage,
        opportunityId: opp._id, __summary: `${opp.contact?.email} → ${stage}`,
      });
      res.json(opp);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.delete("/api/admin/opportunities/:id", protect, adminOnly, async (req, res) => {
    try {
      const opp = await Opportunity.findByIdAndDelete(req.params.id);
      if (!opp) return res.status(404).json({ message: "Opportunity not found" });
      res.json({ deleted: true });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ROUTES — Trigger Links
  // ══════════════════════════════════════════════════════════════════════════

  app.get("/api/admin/trigger-links", protect, adminOnly, async (req, res) => {
    try { res.json(await TrackedLink.find({}).sort("-createdAt").lean()); }
    catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post("/api/admin/trigger-links", protect, adminOnly, async (req, res) => {
    try {
      const { name, url } = req.body || {};
      if (!url?.trim()) return res.status(400).json({ message: "A destination URL is required" });
      const code = crypto.randomBytes(5).toString("hex");
      const link = await TrackedLink.create({ code, name: (name || "").trim(), url: url.trim() });
      res.status(201).json(link);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.delete("/api/admin/trigger-links/:id", protect, adminOnly, async (req, res) => {
    try {
      const link = await TrackedLink.findByIdAndDelete(req.params.id);
      if (!link) return res.status(404).json({ message: "Trigger link not found" });
      res.json({ deleted: true });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // Public — following a trigger link logs the click, fires link_clicked,
  // then redirects to the real destination.
  app.get("/l/:code", async (req, res) => {
    try {
      const link = await TrackedLink.findOneAndUpdate({ code: req.params.code }, { $inc: { clicks: 1 } }, { new: true });
      if (!link) return res.status(404).send("Link not found");
      runWorkflows("link_clicked", {
        studentEmail: link.contactEmail, url: link.url, trackedLinkCode: link.code, trackedLinkName: link.name,
        __summary: `Clicked: ${link.name || link.url}`,
      });
      res.redirect(link.url);
    } catch (err) { res.status(500).send("Something went wrong"); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ROUTES — Internal Notifications (admin-facing, created by a workflow)
  // ══════════════════════════════════════════════════════════════════════════

  app.get("/api/admin/internal-notifications", protect, adminOnly, async (req, res) => {
    try { res.json(await InternalNotification.find({}).sort("-createdAt").limit(50)); }
    catch (err) { res.status(500).json({ message: err.message }); }
  });
  app.patch("/api/admin/internal-notifications/:id/read", protect, adminOnly, async (req, res) => {
    try {
      const notif = await InternalNotification.findByIdAndUpdate(req.params.id, { read: true }, { new: true });
      if (!notif) return res.status(404).json({ message: "Notification not found" });
      res.json(notif);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ROUTES — Inbound messages ("Customer Replied" trigger)
  // ══════════════════════════════════════════════════════════════════════════
  // NOT automatic — only fires once your provider's inbound webhook is
  // pointed at this URL. See server.js's own note near where this used to
  // live for the full explanation.
  app.post("/api/inbound/message", async (req, res) => {
    try {
      const { from, text } = req.body || {};
      if (!from) return res.status(400).json({ message: "from is required" });
      const contact = await Contact.findOne({ $or: [{ email: from }, { phone: from }] });
      runWorkflows("customer_replied", {
        studentEmail: contact?.email || from, studentName: contact?.name || "", message: text || "",
        __summary: `Reply from ${from}`,
      });
      res.json({ received: true });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  return { runWorkflows, upsertContactFromForm, Workflow, Contact, Task, Pipeline, Opportunity, TrackedLink };
};