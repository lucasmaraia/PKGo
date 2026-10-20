// Uninstalls a game or only its update through the system uninstaller, as the
// Remote Package Installer does. Built with the DirectPackageInstaller payload
// template (see build.sh); function names as used by Itemzflow.
//
// Connects back to the PC, reads u32 what (1 = game, 2 = update) and a
// 9-character title ID, then replies with two i32: the init result and the
// uninstall result (0 = success).
#include <stdint.h>
#include "ps4-libjbc/jailbreak.h"

void* dlopen(const char*, int);
void* dlsym(void*, const char*);

// In uninstall_net.c: the socket headers clash with libjbc's types.
int pc_connect(void);
int pc_read(int sock, void* buffer, int length);
void pc_reply(int sock, int32_t* result, int length);

asm("clear_stack:\nmov $0x800,%ecx\nxor %rax, %rax\n.L1:\npush %rax\nloop .L1\nadd $0x4000,%rsp\nret");
void clear_stack(void);

int main()
{
	struct jbc_cred cred;
	jbc_get_cred(&cred);
	jbc_jailbreak_cred(&cred);

	cred.jdir = 0;
	cred.sceProcType = 0x3800000000000010;
	cred.sonyCred = 0x40001c0000000000;
	cred.sceProcCap = 0x900000000000ff00;
	jbc_set_cred(&cred);

	clear_stack();

	void* appinst = dlopen("/system/common/lib/libSceAppInstUtil.sprx", 0);
	int (*sceAppInstUtilInitialize)(void) = dlsym(appinst, "sceAppInstUtilInitialize");
	int (*sceAppInstUtilAppUnInstall)(const char*) = dlsym(appinst, "sceAppInstUtilAppUnInstall");
	int (*sceAppInstUtilAppUnInstallPat)(const char*) = dlsym(appinst, "sceAppInstUtilAppUnInstallPat");

	clear_stack();

	int sock = pc_connect();
	if (sock < 0)
		return -1;

	uint32_t what = 0;
	char title_id[16] = {0};
	if (pc_read(sock, &what, sizeof(what)) || pc_read(sock, title_id, 9)) {
		pc_reply(sock, 0, 0);
		return -1;
	}

	// Initialize may report "already initialized" when another payload used
	// the library in this process; the PC only treats it as the cause on failure.
	int32_t result[2];
	result[0] = sceAppInstUtilInitialize();
	result[1] = what == 2 ? sceAppInstUtilAppUnInstallPat(title_id) : sceAppInstUtilAppUnInstall(title_id);

	pc_reply(sock, result, sizeof(result));
	return 0;
}
