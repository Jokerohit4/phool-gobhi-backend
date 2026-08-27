import * as templateService from '../services/templateService.js';

export const listTemplates = async (req, res) => {
  try {
    const templates = await templateService.listTemplatesService(req.userId);
    res.json({ data: templates });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const createTemplate = async (req, res) => {
  try {
    const template = await templateService.createTemplateService(req.userId, req.body);
    res.status(201).json({ data: template });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateTemplate = async (req, res) => {
  try {
    const templateId = parseInt(req.params.id);
    const template = await templateService.updateTemplateService(templateId, req.userId, req.body);
    res.json({ data: template });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const deleteTemplate = async (req, res) => {
  try {
    const templateId = parseInt(req.params.id);
    await templateService.deleteTemplateService(templateId, req.userId);
    res.json({ data: { deleted: true } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
