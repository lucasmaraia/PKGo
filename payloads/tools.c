// Runs one maintenance command on the PS4 and reports the system results:
//
//   1 = uninstall a game, 2 = uninstall only its update
//       + 9-character title ID. Uses the system uninstaller, as the Remote
//       Package Installer does (function names as used by Itemzflow).
//   3 = remove a download task from the download list (notifications)
//       + i32 task ID (-1 if unknown) + 48-byte content ID. Without the task
//       ID, it is looked up by content ID. Same BGFT service the install
//       payload registers the downloads with.
//
// Built with the DirectPackageInstaller payload template (see build.sh).
// Connects back to the PC, reads the command and replies with two i32:
//   1, 2: the init result and the uninstall result (0 = success)
//   3:    the lookup/stop result and the unregister result (0 = success)
#include <stdint.h>
#include <sys/mman.h>
#include "ps4-libjbc/jailbreak.h"

void* dlopen(const char*, int);
void* dlsym(void*, const char*);

// In tools_net.c: the socket headers clash with libjbc's types.
int pc_connect(void);
int pc_read(int sock, void* buffer, int length);
void pc_reply(int sock, int32_t* result, int length);

// The loop label must not be .L1: GCC numbers its own labels that way.
asm("clear_stack:\nmov $0x800,%ecx\nxor %rax, %rax\n.Lclear_stack:\npush %rax\nloop .Lclear_stack\nadd $0x4000,%rsp\nret");
void clear_stack(void);

enum { UNINSTALL_GAME = 1, UNINSTALL_PATCH = 2, REMOVE_TASK = 3 };

// Not a system error code: a function the firmware should have was not found.
#define MISSING_FUNCTION ((int32_t)0x8F000001)
#define TASK_NOT_FOUND ((int32_t)0x8F000002)
#define BGFT_ALREADY_INITIALIZED ((int32_t)0x80990001)

struct bgft_init_params {
	void* mem;
	unsigned long size;
};

static void uninstall(uint32_t what, const char* title_id, int32_t* result)
{
	void* appinst = dlopen("/system/common/lib/libSceAppInstUtil.sprx", 0);
	int (*sceAppInstUtilInitialize)(void) = dlsym(appinst, "sceAppInstUtilInitialize");
	int (*sceAppInstUtilAppUnInstall)(const char*) = dlsym(appinst, "sceAppInstUtilAppUnInstall");
	int (*sceAppInstUtilAppUnInstallPat)(const char*) = dlsym(appinst, "sceAppInstUtilAppUnInstallPat");
	clear_stack();
	int (*remove)(const char*) = what == UNINSTALL_PATCH ? sceAppInstUtilAppUnInstallPat : sceAppInstUtilAppUnInstall;
	if (!sceAppInstUtilInitialize || !remove) {
		result[0] = MISSING_FUNCTION;
		return;
	}
	// Initialize may report "already initialized" when another payload used
	// the library in this process; the PC only treats it as the cause on failure.
	result[0] = sceAppInstUtilInitialize();
	result[1] = remove(title_id);
}

static void remove_task(int32_t task, const char* content_id, int32_t* result)
{
	void* bgft = dlopen("/system/common/lib/libSceBgft.sprx", 0);
	int (*init)(struct bgft_init_params*) = dlsym(bgft, "sceBgftServiceIntInit");
	int (*find)(const char*, int, int*) = dlsym(bgft, "sceBgftServiceDownloadFindTaskByContentId");
	int (*stop)(int) = dlsym(bgft, "sceBgftServiceIntDownloadStopTask");
	int (*unregister)(int) = dlsym(bgft, "sceBgftServiceIntDownloadUnregisterTask");
	clear_stack();
	if (!init || !stop || !unregister) {
		result[0] = MISSING_FUNCTION;
		return;
	}
	struct bgft_init_params params = {
		.mem = mmap(0, 0x100000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0),
		.size = 0x100000,
	};
	int rv = init(&params);
	if (rv && rv != BGFT_ALREADY_INITIALIZED) {
		result[0] = rv;
		return;
	}
	if (task < 0) {
		// The sub type (game, update, DLC…) is not known here: try each.
		result[0] = TASK_NOT_FOUND;
		for (int sub_type = 1; find && content_id[0] && sub_type <= 12 && task < 0; sub_type++) {
			int found = -1;
			if (!find(content_id, sub_type, &found) && found >= 0)
				task = found;
		}
		if (task < 0)
			return;
	}
	// Stopping fails for a task that already ended; removing it is what matters.
	result[0] = stop(task);
	result[1] = unregister(task);
}

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

	int sock = pc_connect();
	if (sock < 0)
		return -1;

	uint32_t command = 0;
	int32_t result[2] = {0, 0};
	if (pc_read(sock, &command, sizeof(command))) {
		pc_reply(sock, 0, 0);
		return -1;
	}

	if (command == UNINSTALL_GAME || command == UNINSTALL_PATCH) {
		char title_id[16] = {0};
		if (pc_read(sock, title_id, 9)) {
			pc_reply(sock, 0, 0);
			return -1;
		}
		uninstall(command, title_id, result);
	} else if (command == REMOVE_TASK) {
		int32_t task = -1;
		char content_id[49] = {0};
		if (pc_read(sock, &task, sizeof(task)) || pc_read(sock, content_id, 48)) {
			pc_reply(sock, 0, 0);
			return -1;
		}
		remove_task(task, content_id, result);
	} else {
		pc_reply(sock, 0, 0);
		return -1;
	}

	pc_reply(sock, result, sizeof(result));
	return 0;
}
