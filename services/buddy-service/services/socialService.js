const CODE = /^[A-F0-9]{12}$/;
const fail = (status, error) => { throw { status, error }; };

export function validateRecord(body) {
  const exerciseId = Number(body.exerciseId);
  const weight = Number(body.weight);
  const reps = Number(body.reps);
  const exerciseName = typeof body.exerciseName === 'string' ? body.exerciseName.trim() : '';
  if (!Number.isSafeInteger(exerciseId) || exerciseId <= 0 || !exerciseName || exerciseName.length > 150)
    fail(400, 'Select an exercise from the exercise catalogue');
  if (!Number.isFinite(weight) || weight <= 0 || weight > 2000)
    fail(400, 'Weight must be above 0 and at most 2000');
  if (!Number.isInteger(reps) || reps < 1 || reps > 1000) fail(400, 'Reps must be between 1 and 1000');
  if (!['kg', 'lb'].includes(body.unit)) fail(400, 'Choose kg or lb');
  return { exerciseId, exerciseName, weight, reps, unit: body.unit };
}

export function mediaKind(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image';
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image';
  if (buffer.toString('ascii', 4, 8) === 'ftyp') return 'video';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) return 'video';
  fail(400, 'Use a JPEG, PNG, WebP, MP4, MOV or WebM file');
}

export function createSocialService({ prisma, cloudinary, getUserInternal }) {
  async function owner(userId) {
    const p = await prisma.buddyProfile.findUnique({ where: { userId }, include: { photos: true, filter: true } });
    if (!p) fail(404, 'Create your buddy profile first');
    if (!p.isActive || p.moderationHoldAt) fail(403, 'Your buddy profile is unavailable right now');
    const dob = p.dateOfBirth && new Date(p.dateOfBirth);
    const adultOn = dob && new Date(dob.getFullYear() + 18, dob.getMonth(), dob.getDate());
    if (!adultOn || adultOn > new Date()) fail(403, 'An adult buddy profile is required');
    return p;
  }

  async function excluded(viewerId, targetId) {
    const [block, report] = await Promise.all([
      prisma.blockedUser.findFirst({ where: { OR: [
        { blockerId: viewerId, blockedId: targetId }, { blockerId: targetId, blockedId: viewerId }] } }),
      prisma.report.findFirst({ where: { OR: [
        { reporterId: viewerId, reportedUserId: targetId }, { reporterId: targetId, reportedUserId: viewerId }] } }),
    ]);
    return !!(block || report);
  }

  async function target(viewerId, code) {
    if (!CODE.test(code)) fail(404, 'Buddy profile not found');
    const p = await prisma.buddyProfile.findUnique({ where: { publicCode: code }, include: { photos: true, filter: true } });
    if (!p || !p.isShareable) fail(404, 'This buddy profile is not available through a link');
    await owner(p.userId);
    if (viewerId && viewerId !== p.userId) {
      const viewer = await owner(viewerId);
      if (await excluded(viewerId, p.userId)) fail(404, 'Buddy profile not found');
      // Sharing does not bypass the existing women-only safeguards.
      if (p.filter?.womenOnly && (viewer.gender !== 'female' || viewer.womenOnlyBlocked)) fail(404, 'Buddy profile not found');
      if (p.womenOnlyBlocked && viewer.gender === 'female' &&
          (viewer.filter?.womenOnly || (viewer.filter?.genders?.length === 1 && viewer.filter.genders[0] === 'female')))
        fail(404, 'Buddy profile not found');
    }
    // Women-only profiles cannot have anonymous previews, since the viewer's
    // eligibility cannot be checked without a session.
    if (!viewerId && (p.filter?.womenOnly || p.womenOnlyBlocked)) fail(404, 'Open this profile in the app');
    return p;
  }

  async function dto(p, viewerId) {
    const [user, records, followers, follow] = await Promise.all([
      getUserInternal(p.userId),
      prisma.buddyPersonalRecord.findMany({ where: { buddyProfileId: p.id }, orderBy: { createdAt: 'desc' } }),
      prisma.buddyFollow.count({ where: { targetId: p.userId } }),
      viewerId ? prisma.buddyFollow.findUnique({ where: { followerId_targetId: { followerId: viewerId, targetId: p.userId } } }) : null,
    ]);
    return {
      ...(viewerId ? { userId: p.userId } : {}), name: user.name || 'Buddy',
      publicCode: p.publicCode, isShareable: p.isShareable,
      profileImageUrl: p.photos[0]?.url || '', bio: p.bio || '',
      photos: p.photos.map(({ id, url, order }) => ({ id, url, order })),
      isMe: viewerId === p.userId, isFollowing: !!follow, followers,
      records: records.map(({ id, exerciseId, exerciseName, weight, unit, reps, mediaUrl, mediaType }) =>
        ({ id, exerciseId, exerciseName, weight, unit, reps, mediaUrl, mediaType })),
    };
  }

  return {
    async me(userId) { return dto(await owner(userId), userId); },
    async view(userId, code) { return dto(await target(userId, code.toUpperCase()), userId); },
    async settings(userId, body) {
      const p = await owner(userId);
      if (typeof body.isShareable !== 'boolean') fail(400, 'Choose whether to allow profile sharing');
      if (body.isShareable && p.photos.length < 3) fail(400, 'Add 3 profile photos before allowing sharing');
      await prisma.buddyProfile.update({ where: { userId }, data: { isShareable: body.isShareable } });
    },
    async follow(userId, code, enabled) {
      await owner(userId);
      // Unfollow is always possible, even after a target disables sharing.
      if (!enabled) {
        const p = await prisma.buddyProfile.findUnique({ where: { publicCode: code.toUpperCase() } });
        if (p) await prisma.buddyFollow.deleteMany({ where: { followerId: userId, targetId: p.userId } });
        return;
      }
      const p = await target(userId, code.toUpperCase());
      if (p.userId === userId) fail(400, 'You cannot follow yourself');
      await prisma.buddyFollow.upsert({
        where: { followerId_targetId: { followerId: userId, targetId: p.userId } },
        create: { followerId: userId, targetId: p.userId }, update: {},
      });
    },
    async following(userId) {
      await owner(userId);
      const rows = await prisma.buddyFollow.findMany({ where: { followerId: userId },
        include: { target: true }, orderBy: { createdAt: 'desc' }, take: 100 });
      const result = [];
      for (const row of rows) {
        try { result.push(await dto(await target(userId, row.target.publicCode), userId)); }
        catch (err) { if (![403,404].includes(err.status)) throw err; }
      }
      return result;
    },
    async addRecord(userId, body, file) {
      const data = validateRecord(body);
      const p = await owner(userId);
      let uploaded;
      let kind;
      if (file) {
        kind = mediaKind(file.buffer);
        uploaded = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream({ resource_type: kind,
            folder: 'phool-gobhi/buddy-records', allowed_formats: kind === 'video'
              ? ['mp4','mov','webm'] : ['jpg','jpeg','png','webp'] },
          (err, value) => err ? reject(err) : resolve(value)).end(file.buffer);
        });
      }
      try {
        if (kind === 'video' && (!uploaded.duration || uploaded.duration > 60)) fail(400, 'Choose a video up to 60 seconds');
        return await prisma.$transaction(async tx => {
          // Serializes record creation and enforces the limit under concurrent uploads.
          await tx.$queryRaw`SELECT id FROM buddy."BuddyProfile" WHERE id = ${p.id} FOR UPDATE`;
          if (await tx.buddyPersonalRecord.count({ where: { buddyProfileId: p.id } }) >= 30)
            fail(400, 'You can add up to 30 personal records');
          return tx.buddyPersonalRecord.create({ data: { ...data, buddyProfileId: p.id,
            mediaUrl: uploaded?.secure_url, mediaPublicId: uploaded?.public_id, mediaType: kind } });
        });
      } catch (err) {
        if (uploaded) await cloudinary.uploader.destroy(uploaded.public_id, { resource_type: kind });
        throw err;
      }
    },
    async deleteRecord(userId, id) {
      const p = await owner(userId);
      if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Invalid record');
      const record = await prisma.buddyPersonalRecord.findFirst({ where: { id, buddyProfileId: p.id } });
      if (!record) fail(404, 'Personal record not found');
      if (record.mediaPublicId) await cloudinary.uploader.destroy(record.mediaPublicId, { resource_type: record.mediaType });
      await prisma.buddyPersonalRecord.delete({ where: { id } });
    },
  };
}
