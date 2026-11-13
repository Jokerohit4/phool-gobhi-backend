// A token belongs to one signed-in account. Rebinding clears older owners;
// unregister is conditional so a delayed logout cannot clear a newer token.
export async function bindPushToken(prisma, userId, token) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        await tx.user.updateMany({ where: { fcmToken: token, id: { not: userId } }, data: { fcmToken: '' } });
        await tx.user.update({ where: { id: userId }, data: { fcmToken: token } });
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (error.code !== 'P2034' || attempt >= 2) throw error;
    }
  }
}

export function unbindPushToken(prisma, userId, token) {
  return prisma.user.updateMany({ where: { id: userId, fcmToken: token }, data: { fcmToken: '' } });
}
