import * as catalogue from '../services/routines/catalogueService.js';
import * as admin from '../services/routines/catalogueAdminService.js';

// 5xx detail is logged, never returned; 4xx messages are meant for the caller.
function respondError(res, err) {
  const status = err.status || 500;
  if (status >= 500) {
    console.error('[routine-catalogue]', err);
    return res.status(500).json({ error: 'Server error' });
  }
  return res.status(status).json({
    error: err.message,
    ...(err.errorCode ? { errorCode: err.errorCode } : {}),
    ...(err.currentUpdatedAt !== undefined ? { currentUpdatedAt: err.currentUpdatedAt } : {}),
  });
}

const parseId = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error('Invalid id'), { status: 400 });
  return id;
};

export const listCatalogue = async (req, res) => {
  try {
    res.json({ data: await catalogue.listCatalogueService(req.userId, req.query.lang) });
  } catch (err) { respondError(res, err); }
};

export const cloneTemplate = async (req, res) => {
  try {
    const copy = await catalogue.cloneTemplateService(req.userId, parseId(req.params.id), req.query.lang ?? req.body?.lang);
    res.status(201).json({ data: copy });
  } catch (err) { respondError(res, err); }
};

export const adminList = async (req, res) => {
  try { res.json({ data: await admin.adminListTemplatesService() }); } catch (err) { respondError(res, err); }
};

export const adminGet = async (req, res) => {
  try { res.json({ data: await admin.adminGetTemplateService(parseId(req.params.id)) }); } catch (err) { respondError(res, err); }
};

export const adminCreate = async (req, res) => {
  try { res.status(201).json({ data: await admin.adminSaveTemplateService(req.userId, req.body) }); } catch (err) { respondError(res, err); }
};

export const adminUpdate = async (req, res) => {
  try {
    res.json({ data: await admin.adminSaveTemplateService(req.userId, req.body, parseId(req.params.id)) });
  } catch (err) { respondError(res, err); }
};
