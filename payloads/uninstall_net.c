// Connection to the PC for uninstall.c, kept apart because the socket headers
// clash with libjbc's types (the same split as DirectPackageInstaller's info.c).
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>

// Patched by the PKG Sender with the PC address (IPv4 + port, network order).
struct
{
	uint32_t addr;
	uint16_t port;
} __attribute__((packed)) volatile Connection = { 0xb4b4b4b4, 0xb4b4 };

int pc_connect(void)
{
	struct sockaddr_in pc = {
		.sin_family = AF_INET,
		.sin_addr = {.s_addr = Connection.addr},
		.sin_port = Connection.port,
	};
	int sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	if (sock < 0)
		return -1;
	if (connect(sock, (struct sockaddr*)&pc, sizeof(pc)) < 0) {
		close(sock);
		return -1;
	}
	return sock;
}

int pc_read(int sock, void* buffer, int length)
{
	char* p = buffer;
	while (length > 0) {
		ssize_t n = read(sock, p, length);
		if (n <= 0)
			return -1;
		p += n;
		length -= n;
	}
	return 0;
}

void pc_reply(int sock, int32_t* result, int length)
{
	if (length)
		write(sock, result, length);
	close(sock);
}
