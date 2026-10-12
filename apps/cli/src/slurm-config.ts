#!/usr/bin/env node
import os from "node:os";

const host = process.env.TENSORMESH_SLURM_HOST ?? os.hostname().split(".")[0];
const gpuCount = Number(process.env.TENSORMESH_SLURM_GPU_COUNT ?? 8);
const cpus = os.cpus().length;
const memoryMb = Math.floor((os.totalmem() / 1024 / 1024) * 0.97);
const threadsPerCore = Number(process.env.TENSORMESH_SLURM_THREADS_PER_CORE ?? 2);
const sockets = Number(process.env.TENSORMESH_SLURM_SOCKETS ?? 2);
const coresPerSocket = Math.floor(cpus / sockets / threadsPerCore);

process.stdout.write(`# /etc/slurm-llnl/slurm.conf
ClusterName=tensormesh
SlurmctldHost=${host}
SlurmUser=slurm
AuthType=auth/munge
StateSaveLocation=/var/spool/slurmctld
SlurmdSpoolDir=/var/spool/slurmd
SwitchType=switch/none
MpiDefault=none
ProctrackType=proctrack/cgroup
TaskPlugin=task/cgroup,task/affinity
SelectType=select/cons_tres
SelectTypeParameters=CR_Core_Memory
GresTypes=gpu
ReturnToService=2
SlurmctldPidFile=/run/slurmctld.pid
SlurmdPidFile=/run/slurmd.pid
SlurmctldPort=6817
SlurmdPort=6818
InactiveLimit=0
KillWait=30
MinJobAge=300
SlurmctldTimeout=120
SlurmdTimeout=300
Waittime=0
PriorityType=priority/basic
SchedulerType=sched/backfill
PreemptType=preempt/none
PreemptMode=OFF
AccountingStorageType=accounting_storage/none
JobAcctGatherType=jobacct_gather/cgroup
JobAcctGatherFrequency=30

NodeName=${host} CPUs=${cpus} Boards=1 SocketsPerBoard=${sockets} CoresPerSocket=${coresPerSocket} ThreadsPerCore=${threadsPerCore} RealMemory=${memoryMb} Gres=${Array.from({ length: gpuCount }, (_, index) => `gpu:gpu${index}:1`).join(",")} State=UNKNOWN
PartitionName=gpu Nodes=${host} Default=YES MaxTime=90-00:00:00 State=UP

# /etc/slurm-llnl/gres.conf
${Array.from({ length: gpuCount }, (_, index) => `Name=gpu Type=gpu${index} File=/dev/nvidia${index}`).join("\n")}

# /etc/slurm-llnl/cgroup.conf
CgroupAutomount=yes
ConstrainCores=yes
ConstrainDevices=yes
ConstrainRAMSpace=yes
ConstrainSwapSpace=yes
`);
