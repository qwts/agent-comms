// Test-only Darwin/APFS allocation probe. Never linked into shipped software.
#define _DARWIN_C_SOURCE 1
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/attr.h>
#include <sys/snapshot.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <signal.h>

struct slot { const char *name; size_t payload; };
static const struct slot slots[] = {
  {"acceptance",4096},{"action",32768},{"challenge",32768},
  {"presence",4096},{"receipt",4096},{"authorization",4096},
  {"release",4096},{"outcome",4096},{"observation",2048},{"resolution",2048},
  {"scratch",32768}
};
static int mountfd = -1, journalfd = -1;
static dev_t device;
static const char *nonce;

static void failure(const char *phase) {
  int saved = errno;
  printf("{\"event\":\"failure\",\"phase\":\"%s\",\"errno\":%d}\n",phase,saved);
  fflush(stdout); exit(1);
}
static void need(int yes, const char *phase) { if (!yes) { errno = EINVAL; failure(phase); } }
static void close_checked(int fd) { if (close(fd)) failure("close"); }
static void fullflush(int fd) {
  // Deliberately no fsync/barrier fallback if full flush is unsupported.
  if (fcntl(fd,F_FULLFSYNC)) failure("fullfsync");
}
static void dirflush(int fd) { if (fsync(fd)) failure("directory-fsync"); }
static void private_file(int fd, int single) {
  struct stat st;
  if (fstat(fd,&st)) failure("fstat");
  need(S_ISREG(st.st_mode) && st.st_uid == getuid() && (st.st_mode & 07777) == 0600
    && st.st_dev == device && (!single || st.st_nlink == 1),"private-file");
}
static void report(int fd, const char *slot, const char *phase) {
  struct stat st;
  if (fstat(fd,&st)) failure("fstat-observation");
  printf("{\"event\":\"inode\",\"phase\":\"%s\",\"slot\":\"%s\","
    "\"dev\":%llu,\"ino\":%llu,\"bytes\":%lld,\"blocks512\":%lld,\"links\":%u}\n",
    phase,slot,(unsigned long long)st.st_dev,(unsigned long long)st.st_ino,
    (long long)st.st_size,(long long)st.st_blocks,(unsigned)st.st_nlink);
  fflush(stdout);
}
static int open_slot(const char *name, int flags) {
  int fd = openat(journalfd,name,flags | O_NOFOLLOW | O_CLOEXEC,0600);
  if (fd < 0) failure("open-slot");
  private_file(fd,1); return fd;
}
static void setup(const char *mount, const char *token, int create) {
  need(strlen(token)==32 && strspn(token,"0123456789abcdef")==32,"token");
  nonce = token;
  struct statfs filesystem;
  if (statfs(mount,&filesystem)) failure("statfs");
  need(!strcmp(filesystem.f_fstypename,"apfs") && !strcmp(filesystem.f_mntonname,mount),"apfs-mount");
  mountfd = open(mount,O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (mountfd < 0) failure("open-mount");
  struct stat st;
  if (fstat(mountfd,&st)) failure("stat-mount");
  device=st.st_dev;
  need(st.st_uid==getuid() && (st.st_mode & 07777)==0700,"private-mount");
  int identity = openat(mountfd,".lab-identity",O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (identity < 0) failure("identity-open");
  private_file(identity,1);
  char bytes[33]; ssize_t count=read(identity,bytes,sizeof bytes);
  need(count==32 && !memcmp(bytes,nonce,32),"identity-mismatch"); close_checked(identity);
  if (create && mkdirat(mountfd,"journal",0700)) failure("journal-create");
  journalfd=openat(mountfd,"journal",O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (journalfd<0) failure("journal-open");
  if (fstat(journalfd,&st)) failure("journal-stat");
  need(st.st_dev==device && st.st_uid==getuid() && (st.st_mode & 07777)==0700,"journal-identity");
  if (create) { dirflush(journalfd); dirflush(mountfd); }
}
static void reserve(void) {
  for (size_t i=0;i<sizeof slots/sizeof *slots;i++) {
    char name[64]; snprintf(name,sizeof name,"reserve.%s",slots[i].name);
    int fd=open_slot(name,O_RDWR | O_CREAT | O_EXCL);
    fstore_t store={0};
    store.fst_flags=F_ALLOCATEALL | F_ALLOCATEPERSIST;
    store.fst_posmode=F_PEOFPOSMODE;
    store.fst_length=(off_t)(slots[i].payload+256);
    if (fcntl(fd,F_PREALLOCATE,&store)) failure("preallocate");
    need(store.fst_bytesalloc>=store.fst_length,"allocation-short");
    fullflush(fd); report(fd,slots[i].name,"allocated-eof-zero"); close_checked(fd);
    // Observe actual allocation after the final descriptor has closed.
    fd=open_slot(name,O_RDONLY); report(fd,slots[i].name,"closed-reopened"); close_checked(fd);
  }
  dirflush(journalfd);
  printf("{\"event\":\"ready\",\"phase\":\"all-reservations-closed\"}\n"); fflush(stdout);
}
static void control_reserve(void) {
  for(size_t i=0;i<sizeof slots/sizeof *slots;i++) {
    char name[64];snprintf(name,sizeof name,"control.%s",slots[i].name);
    int fd=open_slot(name,O_RDWR | O_CREAT | O_EXCL);
    fullflush(fd);report(fd,slots[i].name,"unreserved-control-created");close_checked(fd);
  }
  dirflush(journalfd);
}
static void control_seed(void) {
  unsigned char bytes[33024];
  for(size_t i=0;i<sizeof slots/sizeof *slots;i++) {
    size_t size=slots[i].payload+256,done=0;
    for(size_t k=0;k<size;k++) bytes[k]=(unsigned char)(1+((k+i+1)%251));
    char name[64];snprintf(name,sizeof name,"control.%s",slots[i].name);
    int fd=open_slot(name,O_RDWR);report(fd,slots[i].name,"control-before-first-write");
    int refusal=0;const char *syscall="pwrite";
    while(done<size) {
      ssize_t n=pwrite(fd,bytes+done,size-done,(off_t)done);
      if(n<0 && errno==EINTR) continue;
      if(n<0 && (errno==ENOSPC || errno==EDQUOT)) {refusal=errno;break;}
      if(n<=0) failure("control-pwrite");
      done+=(size_t)n;
    }
    if(!refusal && fcntl(fd,F_FULLFSYNC)) {
      if(errno!=ENOSPC && errno!=EDQUOT) failure("control-fullfsync");
      refusal=errno;syscall="fcntl-F_FULLFSYNC";
    }
    if(!refusal) {
      unsigned char observed[33024];size_t readBytes=0;struct stat st;
      if(fstat(fd,&st)) failure("control-verify-fstat");
      need(st.st_size==(off_t)size,"control-verify-length");
      while(readBytes<size) {
        ssize_t n=pread(fd,observed+readBytes,size-readBytes,(off_t)readBytes);
        if(n<0 && errno==EINTR) continue;
        if(n<=0) failure("control-verify-read");
        readBytes+=(size_t)n;
      }
      need(!memcmp(bytes,observed,size),"control-verify-content");
    }
    report(fd,slots[i].name,"control-after-first-write");
    printf("{\"event\":\"control-result\",\"slot\":\"%s\",\"requestedBytes\":%zu,"
      "\"writtenBytes\":%zu,\"completed\":%s,\"refusalErrno\":%d,\"refusalSyscall\":\"%s\"}\n",
      slots[i].name,size,done,refusal ? "false" : "true",refusal,refusal ? syscall : "none");
    close_checked(fd);
  }
}
static void observe(void) {
  for (size_t i=0;i<sizeof slots/sizeof *slots;i++) {
    char name[64]; snprintf(name,sizeof name,"reserve.%s",slots[i].name);
    int fd=openat(journalfd,name,O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd<0 && errno==ENOENT) {
      snprintf(name,sizeof name,"%s.record",slots[i].name);
      fd=openat(journalfd,name,O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (fd<0) failure("observe-open");
    private_file(fd,1); report(fd,slots[i].name,"observe"); close_checked(fd);
  }
  struct statfs st;
  if (fstatfs(journalfd,&st)) failure("space-observe");
  printf("{\"event\":\"space\",\"blockSize\":%u,\"freeBlocks\":%llu,\"availableBlocks\":%llu}\n",
    st.f_bsize,(unsigned long long)st.f_bfree,(unsigned long long)st.f_bavail);
}
static void write_all(int fd,const unsigned char *bytes,size_t count,off_t start) {
  size_t done=0;
  while (done<count) {
    ssize_t n=pwrite(fd,bytes+done,count-done,start+(off_t)done);
    if (n<0 && errno==EINTR) continue;
    if (n<=0) failure("pwrite");
    done+=(size_t)n;
  }
}
static void overwrite(unsigned char generation) {
  unsigned char bytes[33024];
  for (size_t i=0;i<sizeof slots/sizeof *slots;i++) {
    size_t size=slots[i].payload+256;
    for (size_t k=0;k<size;k++) bytes[k]=(unsigned char)(1+((k+i+generation)%251));
    char name[64]; snprintf(name,sizeof name,"reserve.%s",slots[i].name);
    int fd=open_slot(name,O_RDWR);
    write_all(fd,bytes,size,0); fullflush(fd);
    unsigned char observed[33024]; size_t done=0;
    while (done<size) {
      ssize_t n=pread(fd,observed+done,size-done,(off_t)done);
      if (n<0 && errno==EINTR) continue;
      if (n<=0) failure("verify-read");
      done+=(size_t)n;
    }
    need(!memcmp(bytes,observed,size),"verify-content");
    report(fd,slots[i].name,generation==1 ? "seed-max" : "overwrite-max-low-space"); close_checked(fd);
  }
}
static void fill(void) {
  int fd=open_slot("filler",O_RDWR | O_CREAT | O_EXCL);
  unsigned char bytes[8192];
  for (size_t k=0;k<sizeof bytes;k++) bytes[k]=(unsigned char)(1+(k%251));
  const uint64_t maximum=128ULL*1024*1024;
  uint64_t total=0; int exhausted=0,refusal=0;const char *syscall="none";
  while (total<maximum) {
    ssize_t n=write(fd,bytes,sizeof bytes);
    if (n<0 && errno==EINTR) continue;
    if (n<0 && (errno==ENOSPC || errno==EDQUOT)) { exhausted=1;refusal=errno;syscall="write";break; }
    if (n<=0) failure("fill-write");
    total+=(uint64_t)n;
    if (total%(256*1024)==0 && fcntl(fd,F_FULLFSYNC)) {
      if (errno==ENOSPC || errno==EDQUOT) { exhausted=1;refusal=errno;syscall="fcntl-F_FULLFSYNC";break; }
      failure("fill-fullfsync");
    }
  }
  printf("{\"event\":\"fill-result\",\"bytes\":%llu,\"exhausted\":%s,"
    "\"refusalErrno\":%d,\"refusalSyscall\":\"%s\"}\n",
    (unsigned long long)total,exhausted ? "true" : "false",refusal,syscall); fflush(stdout);
  close_checked(fd); need(exhausted,"fill-ceiling-without-enospc");
}
static void publish(void) {
  for (size_t i=0;i<sizeof slots/sizeof *slots;i++) {
    if (!strcmp(slots[i].name,"scratch")) continue;
    char from[64],to[64];
    snprintf(from,sizeof from,"reserve.%s",slots[i].name);
    snprintf(to,sizeof to,"%s.record",slots[i].name);
    int fd=open_slot(from,O_RDONLY); report(fd,slots[i].name,"before-link"); close_checked(fd);
    if (linkat(journalfd,from,journalfd,to,0)) failure("publish-link");
    dirflush(journalfd);
    if (unlinkat(journalfd,from,0)) failure("publish-unlink-reservation-name");
    dirflush(journalfd);
    fd=open_slot(to,O_RDONLY); report(fd,slots[i].name,"published"); close_checked(fd);
  }
}
static void verify_generation_two(void) {
  unsigned char expected[33024],observed[33024];
  for (size_t i=0;i<sizeof slots/sizeof *slots;i++) {
    size_t size=slots[i].payload+256;
    for (size_t k=0;k<size;k++) expected[k]=(unsigned char)(1+((k+i+2)%251));
    char name[64];
    snprintf(name,sizeof name,!strcmp(slots[i].name,"scratch") ? "reserve.%s" : "%s.record",slots[i].name);
    int fd=open_slot(name,O_RDONLY);
    struct stat st;
    if (fstat(fd,&st)) failure("verify-final-fstat");
    need(st.st_size==(off_t)size,"verify-final-length");
    size_t done=0;
    while(done<size) {
      ssize_t n=pread(fd,observed+done,size-done,(off_t)done);
      if(n<0 && errno==EINTR) continue;
      if(n<=0) failure("verify-final-read");
      done+=(size_t)n;
    }
    need(!memcmp(expected,observed,size),"verify-final-generation-two");
    report(fd,slots[i].name,"verified-generation-two");close_checked(fd);
  }
}
int main(int argc,char **argv) {
  setvbuf(stdout,NULL,_IOLBF,0);
  need(argc==4,"arguments");
  int reserving=!strcmp(argv[1],"reserve-hold");
  need(reserving || !strcmp(argv[1],"observe") || !strcmp(argv[1],"seed")
    || !strcmp(argv[1],"overwrite") || !strcmp(argv[1],"fill") || !strcmp(argv[1],"publish")
    || !strcmp(argv[1],"snapshot") || !strcmp(argv[1],"verify")
    || !strcmp(argv[1],"control-reserve") || !strcmp(argv[1],"control-seed"),"operation");
  setup(argv[2],argv[3],reserving);
  if (reserving) { reserve(); for (;;) pause(); }
  else if (!strcmp(argv[1],"observe")) observe();
  else if (!strcmp(argv[1],"seed")) overwrite(1);
  else if (!strcmp(argv[1],"overwrite")) overwrite(2);
  else if (!strcmp(argv[1],"fill")) fill();
  else if (!strcmp(argv[1],"control-reserve")) control_reserve();
  else if (!strcmp(argv[1],"control-seed")) control_seed();
  else if (!strcmp(argv[1],"verify")) verify_generation_two();
  else if (!strcmp(argv[1],"snapshot")) {
    char name[64]; snprintf(name,sizeof name,"odj-%s",nonce);
    // No privilege escalation or entitlement workaround. EPERM is evidence.
    if (fs_snapshot_create(mountfd,name,0)) failure("snapshot-create");
    printf("{\"event\":\"snapshot-created\",\"name\":\"%s\"}\n",name);
  }
  else publish();
  close_checked(journalfd); close_checked(mountfd); return 0;
}
